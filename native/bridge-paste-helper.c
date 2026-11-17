/*
 * bridge-paste-helper — persistent Windows helper for the Bridge Suits
 * Stream Deck plugin.
 *
 * For each request read from stdin it:
 *   1. waits (bounded) until no modifier key is physically held,
 *   2. snapshots the current clipboard (all formats it can safely copy),
 *   3. offers CF_UNICODETEXT / "HTML Format" / "Rich Text Format" using
 *      *delayed rendering*, so it learns exactly when the target reads them,
 *   4. sends Ctrl+V (and optionally Ctrl+Space in Word) with SendInput,
 *   5. waits until the target has read the data (or a timeout),
 *   6. restores the snapshot, unless another process has changed the
 *      clipboard in the meantime (then that newer content is left alone).
 *
 * Requests queued while one is in flight reuse the same snapshot, so rapid
 * presses never snapshot our own payload.
 *
 * Protocol: see src/paste-helper.ts. Build: scripts/build-helper.sh.
 * GUI subsystem (-mwindows): no console window. Message-only window: never
 * takes focus.
 */
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <ole2.h>
#include <oleauto.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HELPER_VERSION "1.1.0"

#define WM_APP_REQUEST (WM_APP + 1)
#define WM_APP_EOF (WM_APP + 2)
#define TIMER_ID 1
#define TICK_MS 15
#define MODIFIER_WAIT_MS 1000
#define PASTE_TIMEOUT_MS 2000
#define RENDER_QUIET_MS 250
#define OPEN_RETRIES 50
#define OPEN_RETRY_SLEEP_MS 10
#define RESTORE_ROUNDS 4

#define FLAG_RESET_WORD_FORMATTING 1u

typedef struct {
	BYTE *data;
	size_t len;
} Blob;

typedef struct Request {
	char id[64];
	unsigned flags;
	Blob text; /* UTF-8, converted to UTF-16 when rendered */
	Blob html; /* complete CF_HTML document, UTF-8 */
	Blob rtf;
	BOOL isProbe;
	BOOL isCapture;
	struct Request *next;
} Request;

typedef struct {
	UINT format;
	HANDLE handle;
	BOOL isEmf;
} Saved;

enum State { IDLE, WAIT_MODIFIERS, WAIT_PASTE };

static HWND g_hwnd;
static UINT g_cfHtml, g_cfRtf, g_cfExclude, g_cfHistory, g_cfCloud;
static CRITICAL_SECTION g_outLock;

static Request *g_queueHead, *g_queueTail;
static Request *g_current; /* request being processed */
static Request *g_payload; /* request whose data is currently offered on the clipboard */
static enum State g_state = IDLE;
static ULONGLONG g_stateStart, g_lastRender;
static int g_renderCount;
static BOOL g_ownerLost, g_selfEmptying, g_eof, g_timerOn;
static char g_note[256];

static Saved *g_saved;
static int g_savedCount, g_savedCap, g_skipped;
static BOOL g_haveSnapshot;

/* ---------- output ---------- */

static void write_line(const char *line) {
	DWORD written;
	EnterCriticalSection(&g_outLock);
	WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), line, (DWORD)strlen(line), &written, NULL);
	LeaveCriticalSection(&g_outLock);
}

static void reply(const char *id, const char *status, const char *detail) {
	char line[512];
	snprintf(line, sizeof line, "%s %s%s%s\n", id, status, detail && *detail ? " " : "", detail ? detail : "");
	line[sizeof line - 2] = '\n';
	write_line(line);
}

static void emit_event(const char *kind, const char *message) {
	char line[512];
	snprintf(line, sizeof line, "event %s %s\n", kind, message);
	write_line(line);
}

static void note_append(const char *text) {
	size_t used = strlen(g_note);
	snprintf(g_note + used, sizeof g_note - used, "%s%s", used ? "; " : "", text);
}

/* ---------- request parsing ---------- */

static int b64_value(int c) {
	if (c >= 'A' && c <= 'Z') return c - 'A';
	if (c >= 'a' && c <= 'z') return c - 'a' + 26;
	if (c >= '0' && c <= '9') return c - '0' + 52;
	if (c == '+') return 62;
	if (c == '/') return 63;
	return -1;
}

/* Decodes base64 (or "-" = empty). Returns FALSE on malformed input. */
static BOOL b64_decode(const char *in, Blob *out) {
	out->data = NULL;
	out->len = 0;
	if (strcmp(in, "-") == 0) return TRUE;
	size_t n = strlen(in);
	out->data = malloc(n / 4 * 3 + 3);
	if (!out->data) return FALSE;
	unsigned acc = 0;
	int bits = 0;
	for (size_t i = 0; i < n; i++) {
		if (in[i] == '=') break;
		int v = b64_value((unsigned char)in[i]);
		if (v < 0) return FALSE;
		acc = (acc << 6) | (unsigned)v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out->data[out->len++] = (BYTE)(acc >> bits);
		}
	}
	return TRUE;
}

static void free_request(Request *r) {
	if (!r) return;
	free(r->text.data);
	free(r->html.data);
	free(r->rtf.data);
	free(r);
}

/* "<id> <flags> <text> <html> <rtf>" */
static Request *parse_request(char *line, char *errId, size_t errIdSize) {
	char *fields[5];
	int count = 0;
	snprintf(errId, errIdSize, "?");
	for (char *p = line; *p && count < 6;) {
		while (*p == ' ' || *p == '\r') *p++ = '\0';
		if (!*p) break;
		if (count == 5) {
			snprintf(errId, errIdSize, "%s", fields[0]);
			return NULL; /* too many fields */
		}
		fields[count++] = p;
		while (*p && *p != ' ' && *p != '\r') p++;
	}
	snprintf(errId, errIdSize, "%s", count > 0 ? fields[0] : "?");
	if (count != 5 || strlen(fields[0]) >= sizeof(((Request *)0)->id)) return NULL;

	Request *r = calloc(1, sizeof *r);
	if (!r) return NULL;
	strcpy(r->id, fields[0]);
	r->flags = (unsigned)strtoul(fields[1], NULL, 10);
	if (!b64_decode(fields[2], &r->text) || !b64_decode(fields[3], &r->html) || !b64_decode(fields[4], &r->rtf) || !r->text.len) {
		free_request(r);
		return NULL;
	}
	return r;
}

static DWORD WINAPI stdin_reader(LPVOID unused) {
	(void)unused;
	HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
	size_t cap = 4096, len = 0;
	char *buf = malloc(cap);
	char chunk[4096];
	DWORD got;
	while (buf && ReadFile(in, chunk, sizeof chunk, &got, NULL) && got > 0) {
		if (len + got + 1 > cap) {
			while (len + got + 1 > cap) cap *= 2;
			char *grown = realloc(buf, cap);
			if (!grown) break;
			buf = grown;
		}
		memcpy(buf + len, chunk, got);
		len += got;
		char *start = buf, *nl;
		while ((nl = memchr(start, '\n', len - (size_t)(start - buf))) != NULL) {
			*nl = '\0';
			size_t lineLen = strlen(start);
			if (lineLen && start[lineLen - 1] == '\r') start[--lineLen] = '\0';
			const char *verb = NULL;
			if (lineLen > 6 && strcmp(start + lineLen - 6, " probe") == 0) verb = " probe";
			else if (lineLen > 8 && strcmp(start + lineLen - 8, " capture") == 0) verb = " capture";
			if (verb && lineLen - strlen(verb) < 64) {
				start[lineLen - strlen(verb)] = '\0';
				Request *r = calloc(1, sizeof *r);
				if (r) {
					strcpy(r->id, start);
					r->isProbe = verb[1] == 'p';
					r->isCapture = verb[1] == 'c';
					PostMessage(g_hwnd, WM_APP_REQUEST, 0, (LPARAM)r);
				}
			} else if (*start) {
				char errId[64];
				Request *r = parse_request(start, errId, sizeof errId);
				if (r) PostMessage(g_hwnd, WM_APP_REQUEST, 0, (LPARAM)r);
				else reply(errId, "error", "bad_request malformed request line");
			}
			start = nl + 1;
		}
		len -= (size_t)(start - buf);
		memmove(buf, start, len);
	}
	free(buf);
	PostMessage(g_hwnd, WM_APP_EOF, 0, 0);
	return 0;
}

/* ---------- clipboard snapshot / restore ---------- */

static BOOL open_clipboard(void) {
	for (int i = 0; i < OPEN_RETRIES; i++) {
		if (OpenClipboard(g_hwnd)) return TRUE;
		Sleep(OPEN_RETRY_SLEEP_MS);
	}
	return FALSE;
}

static HGLOBAL global_from_bytes(const void *data, size_t len, size_t extraZeroBytes) {
	HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, len + extraZeroBytes);
	if (!h) return NULL;
	BYTE *p = GlobalLock(h);
	if (len) memcpy(p, data, len);
	memset(p + len, 0, extraZeroBytes);
	GlobalUnlock(h);
	return h;
}

static HGLOBAL copy_hglobal(HANDLE src) {
	SIZE_T n = GlobalSize(src);
	if (!n) return NULL;
	void *s = GlobalLock(src);
	if (!s) return NULL;
	HGLOBAL copy = global_from_bytes(s, n, 0);
	GlobalUnlock(src);
	return copy;
}

static void free_snapshot(void) {
	for (int i = 0; i < g_savedCount; i++) {
		if (!g_saved[i].handle) continue;
		if (g_saved[i].isEmf) DeleteEnhMetaFile(g_saved[i].handle);
		else GlobalFree(g_saved[i].handle);
	}
	free(g_saved);
	g_saved = NULL;
	g_savedCount = g_savedCap = g_skipped = 0;
	g_haveSnapshot = FALSE;
}

/* Formats Windows synthesizes from another format that we do save. */
static BOOL is_synthesized_equivalent(UINT f) {
	return f == CF_BITMAP || f == CF_METAFILEPICT || f == CF_PALETTE;
}

/* Handle-based formats whose data cannot be duplicated generically. */
static BOOL is_uncopyable(UINT f) {
	return f == CF_OWNERDISPLAY || f == CF_DSPBITMAP || f == CF_DSPMETAFILEPICT || f == CF_DSPENHMETAFILE ||
	       (f >= CF_PRIVATEFIRST && f <= CF_PRIVATELAST) || (f >= CF_GDIOBJFIRST && f <= CF_GDIOBJLAST);
}

/* Clipboard must be open. */
static void take_snapshot(void) {
	free_snapshot();
	UINT f = 0;
	while ((f = EnumClipboardFormats(f)) != 0) {
		if (is_synthesized_equivalent(f)) continue;
		if (is_uncopyable(f)) {
			g_skipped++;
			continue;
		}
		HANDLE h = GetClipboardData(f);
		HANDLE copy = NULL;
		BOOL emf = (f == CF_ENHMETAFILE);
		if (h) copy = emf ? (HANDLE)CopyEnhMetaFile((HENHMETAFILE)h, NULL) : copy_hglobal(h);
		if (!copy) {
			g_skipped++;
			continue;
		}
		if (g_savedCount == g_savedCap) {
			int cap = g_savedCap ? g_savedCap * 2 : 16;
			Saved *grown = realloc(g_saved, (size_t)cap * sizeof *grown);
			if (!grown) {
				if (emf) DeleteEnhMetaFile(copy);
				else GlobalFree(copy);
				g_skipped++;
				continue;
			}
			g_saved = grown;
			g_savedCap = cap;
		}
		g_saved[g_savedCount++] = (Saved){f, copy, emf};
	}
	g_haveSnapshot = TRUE;
}

/* Marks clipboard content as transient so Win+V history / cloud clipboard / monitors skip it. Clipboard must be open. */
static void set_private_markers(void) {
	DWORD zero = 0;
	if (g_cfExclude) SetClipboardData(g_cfExclude, global_from_bytes(&zero, sizeof zero, 0));
	if (g_cfHistory) SetClipboardData(g_cfHistory, global_from_bytes(&zero, sizeof zero, 0));
	if (g_cfCloud) SetClipboardData(g_cfCloud, global_from_bytes(&zero, sizeof zero, 0));
}

static void empty_own_clipboard(void) {
	g_selfEmptying = TRUE;
	EmptyClipboard();
	g_selfEmptying = FALSE;
}

/* Clipboard must be open. */
static void write_restored_snapshot(void) {
	empty_own_clipboard();
	BOOL hasHistoryMarker = FALSE;
	for (int i = 0; i < g_savedCount; i++) {
		if (g_saved[i].format == g_cfHistory) hasHistoryMarker = TRUE;
		if (SetClipboardData(g_saved[i].format, g_saved[i].handle)) g_saved[i].handle = NULL; /* now owned by the system */
	}
	/* The original content is already in Win+V history; do not add a duplicate. */
	if (g_savedCount && !hasHistoryMarker && g_cfHistory) {
		DWORD zero = 0;
		SetClipboardData(g_cfHistory, global_from_bytes(&zero, sizeof zero, 0));
	}
}

static void release_payload(void) {
	free_request(g_payload);
	g_payload = NULL;
}

static void restore_clipboard(void) {
	if (!g_haveSnapshot) return;
	if (g_ownerLost || GetClipboardOwner() != g_hwnd) {
		/* Someone copied something after our paste: that newer content wins. */
		free_snapshot();
		release_payload();
		return;
	}
	BOOL opened = FALSE;
	for (int round = 0; round < RESTORE_ROUNDS && !opened; round++) opened = open_clipboard();
	if (!opened) {
		emit_event("restore_failed", "clipboard stayed locked by another application; previous clipboard contents could not be restored");
	} else {
		if (GetClipboardOwner() == g_hwnd && !g_ownerLost) {
			write_restored_snapshot();
			if (g_skipped) {
				char msg[128];
				snprintf(msg, sizeof msg, "%d clipboard format(s) could not be preserved", g_skipped);
				emit_event("restore_partial", msg);
			}
		}
		CloseClipboard();
	}
	free_snapshot();
	release_payload();
}

/* ---------- delayed rendering ---------- */

static HGLOBAL render_data(const Request *r, UINT format) {
	if (!r) return NULL;
	if (format == CF_UNICODETEXT) {
		int chars = MultiByteToWideChar(CP_UTF8, 0, (LPCCH)r->text.data, (int)r->text.len, NULL, 0);
		if (chars <= 0) return NULL;
		HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, ((size_t)chars + 1) * sizeof(WCHAR));
		if (!h) return NULL;
		WCHAR *w = GlobalLock(h);
		MultiByteToWideChar(CP_UTF8, 0, (LPCCH)r->text.data, (int)r->text.len, w, chars);
		w[chars] = 0;
		GlobalUnlock(h);
		return h;
	}
	if (format == g_cfHtml && r->html.len) return global_from_bytes(r->html.data, r->html.len, 1);
	if (format == g_cfRtf && r->rtf.len) return global_from_bytes(r->rtf.data, r->rtf.len, 1);
	return NULL;
}

static void render_format(UINT format) {
	HGLOBAL h = render_data(g_payload, format);
	if (h && !SetClipboardData(format, h)) GlobalFree(h);
	if (h) {
		g_renderCount++;
		g_lastRender = GetTickCount64();
	}
}

/* Clipboard must be open. Our window becomes the owner. */
static void write_payload(Request *r) {
	empty_own_clipboard();
	release_payload();
	g_payload = r;
	if (r->rtf.len) SetClipboardData(g_cfRtf, NULL);
	if (r->html.len) SetClipboardData(g_cfHtml, NULL);
	SetClipboardData(CF_UNICODETEXT, NULL);
	set_private_markers();
	g_ownerLost = FALSE;
	g_renderCount = 0;
}

/* ---------- input ---------- */

static BOOL modifiers_down(void) {
	static const int keys[] = {VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN};
	for (size_t i = 0; i < sizeof keys / sizeof keys[0]; i++)
		if (GetAsyncKeyState(keys[i]) & 0x8000) return TRUE;
	return FALSE;
}

static void key_input(INPUT *in, WORD vk, BOOL up) {
	ZeroMemory(in, sizeof *in);
	in->type = INPUT_KEYBOARD;
	in->ki.wVk = vk;
	in->ki.wScan = (WORD)MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
	in->ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
}

static UINT add_chord(INPUT *in, WORD modifier, WORD key) {
	key_input(&in[0], modifier, FALSE);
	key_input(&in[1], key, FALSE);
	key_input(&in[2], key, TRUE);
	key_input(&in[3], modifier, TRUE);
	return 4;
}

static BOOL is_word_window(HWND hwnd) {
	WCHAR cls[64];
	return GetClassNameW(hwnd, cls, 64) && wcscmp(cls, L"OpusApp") == 0;
}

static DWORD token_integrity(HANDLE token) {
	DWORD len = 0, rid = 0;
	GetTokenInformation(token, TokenIntegrityLevel, NULL, 0, &len);
	TOKEN_MANDATORY_LABEL *label = len ? malloc(len) : NULL;
	if (label && GetTokenInformation(token, TokenIntegrityLevel, label, len, &len)) {
		PSID sid = label->Label.Sid;
		rid = *GetSidSubAuthority(sid, (DWORD)(*GetSidSubAuthorityCount(sid) - 1));
	}
	free(label);
	return rid;
}

/* 1 = target runs at a higher integrity level (UIPI would drop our input), 0 = fine, -1 = unknown. */
static int target_more_privileged(HWND target) {
	DWORD pid = 0;
	GetWindowThreadProcessId(target, &pid);
	HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
	if (!proc) return -1;
	int result = -1;
	HANDLE theirs, ours;
	if (OpenProcessToken(proc, TOKEN_QUERY, &theirs)) {
		if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &ours)) {
			DWORD a = token_integrity(theirs), b = token_integrity(ours);
			if (a && b) result = a > b;
			CloseHandle(ours);
		}
		CloseHandle(theirs);
	}
	CloseHandle(proc);
	return result;
}


/* ---------- Microsoft Word object model (COM automation, no VBA) ---------- */

typedef struct {
	WCHAR name[64];
	double size;
	LONG color;
	BOOL valid;
} WordFormat;

static WordFormat g_restoreFormat;

static HRESULT invoke_retry(IDispatch *obj, DISPID id, WORD flags, DISPPARAMS *params, VARIANT *result) {
	HRESULT hr = E_FAIL;
	for (int i = 0; i < 20; i++) {
		hr = obj->lpVtbl->Invoke(obj, id, &IID_NULL, LOCALE_USER_DEFAULT, flags, params, result, NULL, NULL);
		if (hr != RPC_E_CALL_REJECTED && hr != RPC_E_SERVERCALL_RETRYLATER) break;
		Sleep(25); /* Word is busy (e.g. still handling the paste) */
	}
	return hr;
}

static DISPID dispid_of(IDispatch *obj, const WCHAR *name) {
	DISPID id = DISPID_UNKNOWN;
	LPOLESTR n = (LPOLESTR)name;
	obj->lpVtbl->GetIDsOfNames(obj, &IID_NULL, &n, 1, LOCALE_USER_DEFAULT, &id);
	return id;
}

static HRESULT disp_get(IDispatch *obj, const WCHAR *name, VARIANT *out) {
	VariantInit(out);
	DISPID id = dispid_of(obj, name);
	if (id == DISPID_UNKNOWN) return DISP_E_UNKNOWNNAME;
	DISPPARAMS none = {NULL, NULL, 0, 0};
	return invoke_retry(obj, id, DISPATCH_PROPERTYGET, &none, out);
}

static HRESULT disp_put(IDispatch *obj, const WCHAR *name, VARIANT *value) {
	DISPID id = dispid_of(obj, name);
	if (id == DISPID_UNKNOWN) return DISP_E_UNKNOWNNAME;
	DISPID named = DISPID_PROPERTYPUT;
	DISPPARAMS params = {value, &named, 1, 1};
	return invoke_retry(obj, id, DISPATCH_PROPERTYPUT, &params, NULL);
}

/* Word.Application.Selection.Font of the running Word, or NULL. */
static IDispatch *word_selection_font(void) {
	CLSID clsid;
	IUnknown *unk = NULL;
	IDispatch *app = NULL, *font = NULL;
	VARIANT selection, fontVar;
	if (FAILED(CLSIDFromProgID(L"Word.Application", &clsid)) || FAILED(GetActiveObject(&clsid, NULL, &unk))) return NULL;
	HRESULT hr = unk->lpVtbl->QueryInterface(unk, &IID_IDispatch, (void **)&app);
	unk->lpVtbl->Release(unk);
	if (FAILED(hr)) return NULL;
	if (SUCCEEDED(disp_get(app, L"Selection", &selection)) && selection.vt == VT_DISPATCH && selection.pdispVal) {
		if (SUCCEEDED(disp_get(selection.pdispVal, L"Font", &fontVar)) && fontVar.vt == VT_DISPATCH) font = fontVar.pdispVal;
		VariantClear(&selection);
	}
	app->lpVtbl->Release(app);
	return font;
}

static BOOL word_read_format(WordFormat *out) {
	ZeroMemory(out, sizeof *out);
	IDispatch *font = word_selection_font();
	if (!font) return FALSE;
	VARIANT v;
	if (SUCCEEDED(disp_get(font, L"Name", &v)) && v.vt == VT_BSTR && v.bstrVal && v.bstrVal[0]) lstrcpynW(out->name, v.bstrVal, 64);
	VariantClear(&v);
	if (SUCCEEDED(disp_get(font, L"Size", &v)) && SUCCEEDED(VariantChangeType(&v, &v, 0, VT_R8)) && v.dblVal > 0 && v.dblVal < 1639)
		out->size = v.dblVal; /* mixed selections report 9999999 */
	VariantClear(&v);
	BOOL haveColor = SUCCEEDED(disp_get(font, L"Color", &v)) && SUCCEEDED(VariantChangeType(&v, &v, 0, VT_I4));
	if (haveColor) out->color = v.lVal;
	VariantClear(&v);
	font->lpVtbl->Release(font);
	out->valid = haveColor; /* colour is what the typing restore needs most */
	return out->valid || out->name[0];
}

static BOOL word_restore_format(const WordFormat *f) {
	IDispatch *font = word_selection_font();
	if (!font) return FALSE;
	BOOL ok = TRUE;
	VARIANT v;
	if (f->name[0]) {
		VariantInit(&v);
		v.vt = VT_BSTR;
		v.bstrVal = SysAllocString(f->name);
		ok &= SUCCEEDED(disp_put(font, L"Name", &v));
		VariantClear(&v);
	}
	if (f->size > 0) {
		VariantInit(&v);
		v.vt = VT_R4;
		v.fltVal = (float)f->size;
		ok &= SUCCEEDED(disp_put(font, L"Size", &v));
	}
	VariantInit(&v);
	v.vt = VT_I4;
	v.lVal = f->color; /* includes wdColorAutomatic */
	ok &= SUCCEEDED(disp_put(font, L"Color", &v));
	font->lpVtbl->Release(font);
	return ok;
}

/* 1 = font draws all four suits, 0 = it does not, -1 = font not installed. */
static int font_has_suit_glyphs(const WCHAR *name) {
	LOGFONTW lf = {0};
	lf.lfHeight = -16;
	lf.lfCharSet = DEFAULT_CHARSET;
	lstrcpynW(lf.lfFaceName, name, LF_FACESIZE);
	HFONT font = CreateFontIndirectW(&lf);
	HDC dc = CreateCompatibleDC(NULL);
	if (!font || !dc) {
		if (font) DeleteObject(font);
		if (dc) DeleteDC(dc);
		return -1;
	}
	HGDIOBJ old = SelectObject(dc, font);
	WCHAR face[LF_FACESIZE] = {0};
	GetTextFaceW(dc, LF_FACESIZE, face);
	int result = -1;
	if (lstrcmpiW(face, name) == 0) {
		WORD glyphs[4];
		static const WCHAR suits[] = {0x2660, 0x2663, 0x2665, 0x2666};
		result = GetGlyphIndicesW(dc, suits, 4, glyphs, GGI_MARK_NONEXISTING_GLYPHS) == 4 && glyphs[0] != 0xFFFF &&
		         glyphs[1] != 0xFFFF && glyphs[2] != 0xFFFF && glyphs[3] != 0xFFFF;
	}
	SelectObject(dc, old);
	DeleteObject(font);
	DeleteDC(dc);
	return result;
}

/* Text fonts with ♠♣♥♦ glyphs for documents whose font has none. */
static const WCHAR *const SUIT_FALLBACK_FONTS[] = {L"Segoe UI Symbol", L"Arial"};

static const WCHAR *suit_font_for(const WCHAR *documentFont) {
	if (!documentFont[0] || font_has_suit_glyphs(documentFont) != 0) return documentFont;
	for (size_t i = 0; i < sizeof SUIT_FALLBACK_FONTS / sizeof *SUIT_FALLBACK_FONTS; i++)
		if (font_has_suit_glyphs(SUIT_FALLBACK_FONTS[i]) == 1) return SUIT_FALLBACK_FONTS[i];
	return documentFont;
}

static void b64_encode(const BYTE *in, size_t len, char *out, size_t outSize) {
	static const char t[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	size_t o = 0;
	for (size_t i = 0; i < len && o + 5 < outSize; i += 3) {
		unsigned v = (unsigned)in[i] << 16 | (i + 1 < len ? (unsigned)in[i + 1] << 8 : 0) | (i + 2 < len ? in[i + 2] : 0);
		out[o++] = t[v >> 18 & 63];
		out[o++] = t[v >> 12 & 63];
		out[o++] = i + 1 < len ? t[v >> 6 & 63] : '=';
		out[o++] = i + 2 < len ? t[v & 63] : '=';
	}
	out[o] = '\0';
}

/* "font=<base64 UTF-8> size=<pt>" for the focused Word document, or "". */
static void probe_note(char *out, size_t outSize) {
	out[0] = '\0';
	HWND fg = GetForegroundWindow();
	WCHAR cls[64];
	if (!fg || !GetClassNameW(fg, cls, 64) || wcscmp(cls, L"OpusApp") != 0) return;
	WordFormat f;
	if (!word_read_format(&f)) return;
	if (f.name[0]) {
		/* font = a font with ♠♥♦♣ glyphs (the document font if it has them);
		 * doc = the document font itself, for snippets that are not suits. */
		const WCHAR *names[2] = {suit_font_for(f.name), f.name};
		const char *keys[2] = {"font", "doc"};
		for (int k = 0; k < 2; k++) {
			char utf8[256], b64[400];
			int n = WideCharToMultiByte(CP_UTF8, 0, names[k], -1, utf8, sizeof utf8, NULL, NULL);
			if (n > 1) {
				b64_encode((const BYTE *)utf8, (size_t)n - 1, b64, sizeof b64);
				size_t used = strlen(out);
				snprintf(out + used, outSize - used, "%s%s=%s", used ? " " : "", keys[k], b64);
			}
		}
	}
	if (f.size > 0) {
		size_t used = strlen(out);
		snprintf(out + used, outSize - used, "%ssize=%g", used ? " " : "", f.size);
	}
}

/* ---------- clipboard capture ---------- */

#define CAPTURE_MAX_BYTES (4u << 20)

/* Appends " key=<base64>" to *out (grown with realloc). Returns FALSE on OOM. */
static BOOL append_b64_field(char **out, size_t *len, const char *key, const BYTE *data, size_t n) {
	size_t need = *len + strlen(key) + 2 + (n + 2) / 3 * 4 + 2; /* b64_encode wants one spare byte */
	char *grown = realloc(*out, need);
	if (!grown) return FALSE;
	*out = grown;
	*len += (size_t)sprintf(*out + *len, " %s=", key);
	b64_encode(data, n, *out + *len, need - *len);
	*len += strlen(*out + *len);
	return TRUE;
}

/* Bytes of a clipboard format up to its first NUL (RTF and CF_HTML are NUL-terminated). */
static void clipboard_bytes(UINT format, BYTE **data, size_t *n) {
	*data = NULL;
	*n = 0;
	HANDLE h = GetClipboardData(format);
	const BYTE *p = h ? GlobalLock(h) : NULL;
	if (!p) return;
	SIZE_T size = GlobalSize(h);
	size_t len = 0;
	while (len < size && p[len]) len++;
	if (len && len <= CAPTURE_MAX_BYTES && (*data = malloc(len))) {
		memcpy(*data, p, len);
		*n = len;
	}
	GlobalUnlock(h);
}

/*
 * Replies "<id> ok [text=<b64>] [rtf=<b64>] [html=<b64>]" with what is on the
 * clipboard right now (text as UTF-8, RTF and CF_HTML as raw bytes), so the
 * plugin can turn something the user copied into a custom snippet.
 */
static void answer_capture(const char *id) {
	restore_clipboard(); /* never capture our own temporary payload */
	if (!open_clipboard()) return reply(id, "error", "clipboard_busy clipboard is locked by another application");
	BYTE *text = NULL, *rtf = NULL, *html = NULL;
	size_t textLen = 0, rtfLen = 0, htmlLen = 0;
	HANDLE h = GetClipboardData(CF_UNICODETEXT);
	const WCHAR *w = h ? GlobalLock(h) : NULL;
	if (w) {
		int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
		if (n > 1 && (size_t)n <= CAPTURE_MAX_BYTES && (text = malloc((size_t)n))) {
			WideCharToMultiByte(CP_UTF8, 0, w, -1, (char *)text, n, NULL, NULL);
			textLen = (size_t)n - 1;
		}
		GlobalUnlock(h);
	}
	clipboard_bytes(g_cfRtf, &rtf, &rtfLen);
	clipboard_bytes(g_cfHtml, &html, &htmlLen);
	CloseClipboard();

	size_t len = strlen(id) + 3;
	char *line = malloc(len + 1);
	BOOL ok = line != NULL;
	if (ok) sprintf(line, "%s ok", id);
	if (ok && textLen) ok = append_b64_field(&line, &len, "text", text, textLen);
	if (ok && rtfLen) ok = append_b64_field(&line, &len, "rtf", rtf, rtfLen);
	if (ok && htmlLen) ok = append_b64_field(&line, &len, "html", html, htmlLen);
	if (ok) {
		char *grown = realloc(line, len + 2);
		ok = grown != NULL;
		if (ok) {
			line = grown;
			line[len++] = '\n';
			line[len] = '\0';
			write_line(line);
		}
	}
	if (!ok) reply(id, "error", "out_of_memory clipboard contents too large");
	free(line);
	free(text);
	free(rtf);
	free(html);
}

/* ---------- request state machine ---------- */

static void set_timer(BOOL on) {
	if (on && !g_timerOn) SetTimer(g_hwnd, TIMER_ID, TICK_MS, NULL);
	if (!on && g_timerOn) KillTimer(g_hwnd, TIMER_ID);
	g_timerOn = on;
}

static void start_next(void);

static void finish_request(BOOL ok, const char *codeAndMessage) {
	if (ok && g_restoreFormat.valid && !word_restore_format(&g_restoreFormat)) note_append("could not restore the typing format in Word");
	g_restoreFormat.valid = FALSE;
	if (ok) reply(g_current->id, "ok", g_note);
	else reply(g_current->id, "error", codeAndMessage);
	free_request(g_current == g_payload ? NULL : g_current);
	g_current = NULL;
	g_state = IDLE;
	set_timer(FALSE);
	if (g_ownerLost) {
		free_snapshot();
		release_payload();
	}
	start_next();
}

static void begin_paste(void) {
	HWND target = GetForegroundWindow();
	if (!target) return finish_request(FALSE, "no_foreground_window no window has keyboard focus");
	int privileged = target_more_privileged(target);
	if (privileged == 1)
		return finish_request(FALSE, "target_elevated the focused application runs elevated; Windows blocks simulated input to it");
	if (privileged < 0) note_append("could not verify target integrity level");

	if (!open_clipboard()) return finish_request(FALSE, "clipboard_busy clipboard is locked by another application");
	if (!g_haveSnapshot) take_snapshot();
	write_payload(g_current);
	CloseClipboard();

	INPUT inputs[8];
	UINT count = add_chord(inputs, VK_CONTROL, 'V');
	if ((g_current->flags & FLAG_RESET_WORD_FORMATTING) && is_word_window(target)) {
		/* Prefer giving the insertion point its exact previous formatting back
		 * through Word's object model; Ctrl+Space (reset to style) is the fallback. */
		if (!word_read_format(&g_restoreFormat) || !g_restoreFormat.valid) {
			g_restoreFormat.valid = FALSE;
			count += add_chord(inputs + count, VK_CONTROL, VK_SPACE);
		}
	}
	if (SendInput(count, inputs, sizeof(INPUT)) != count) {
		/* Payload is on the clipboard; restore happens via the normal path. */
		return finish_request(FALSE, "sendinput_failed keyboard input was blocked");
	}
	g_state = WAIT_PASTE;
	g_stateStart = GetTickCount64();
}

static void tick(void) {
	ULONGLONG now = GetTickCount64();
	if (g_state == WAIT_MODIFIERS) {
		if (!modifiers_down()) return begin_paste();
		if (now - g_stateStart >= MODIFIER_WAIT_MS)
			return finish_request(FALSE, "modifier_held release Shift/Ctrl/Alt/Win before pressing the key");
		return;
	}
	if (g_state == WAIT_PASTE) {
		if (g_ownerLost) {
			note_append("clipboard changed by another application; left as is");
			return finish_request(TRUE, NULL);
		}
		if (g_renderCount > 0 && now - g_lastRender >= RENDER_QUIET_MS) return finish_request(TRUE, NULL);
		if (now - g_stateStart >= PASTE_TIMEOUT_MS) {
			if (g_renderCount > 0) return finish_request(TRUE, NULL);
			return finish_request(FALSE, "paste_not_observed the focused application did not read the clipboard");
		}
	}
}

static void start_next(void) {
	if (g_state != IDLE) return;
	Request *r = g_queueHead;
	if (!r) {
		restore_clipboard();
		if (g_eof) DestroyWindow(g_hwnd);
		return;
	}
	g_queueHead = r->next;
	if (!g_queueHead) g_queueTail = NULL;
	r->next = NULL;
	g_current = r;
	g_note[0] = '\0';
	if (r->isProbe || r->isCapture) {
		char note[512];
		if (r->isCapture) answer_capture(r->id);
		else {
			probe_note(note, sizeof note);
			reply(r->id, "ok", note);
		}
		free_request(r);
		g_current = NULL;
		start_next();
		return;
	}
	g_state = WAIT_MODIFIERS;
	g_stateStart = GetTickCount64();
	set_timer(TRUE);
	tick();
}

/* ---------- window ---------- */

static LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	switch (msg) {
	case WM_APP_REQUEST: {
		Request *r = (Request *)lp;
		if (g_queueTail) g_queueTail->next = r;
		else g_queueHead = r;
		g_queueTail = r;
		start_next();
		return 0;
	}
	case WM_APP_EOF:
		g_eof = TRUE;
		start_next();
		return 0;
	case WM_TIMER:
		tick();
		return 0;
	case WM_RENDERFORMAT:
		render_format((UINT)wp);
		return 0;
	case WM_RENDERALLFORMATS:
		if (OpenClipboard(hwnd)) {
			if (GetClipboardOwner() == hwnd) {
				render_format(CF_UNICODETEXT);
				render_format(g_cfHtml);
				render_format(g_cfRtf);
			}
			CloseClipboard();
		}
		return 0;
	case WM_DESTROYCLIPBOARD:
		if (!g_selfEmptying) g_ownerLost = TRUE;
		return 0;
	case WM_DESTROY:
		PostQuitMessage(0);
		return 0;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE prev, LPSTR cmdLine, int show) {
	(void)prev;
	(void)cmdLine;
	(void)show;
	InitializeCriticalSection(&g_outLock);
	CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
	g_cfHtml = RegisterClipboardFormatW(L"HTML Format");
	g_cfRtf = RegisterClipboardFormatW(L"Rich Text Format");
	g_cfExclude = RegisterClipboardFormatW(L"ExcludeClipboardContentFromMonitorProcessing");
	g_cfHistory = RegisterClipboardFormatW(L"CanIncludeInClipboardHistory");
	g_cfCloud = RegisterClipboardFormatW(L"CanUploadToCloudClipboard");

	WNDCLASSW wc = {0};
	wc.lpfnWndProc = wnd_proc;
	wc.hInstance = instance;
	wc.lpszClassName = L"BridgePasteHelper";
	if (!RegisterClassW(&wc)) return 1;
	g_hwnd = CreateWindowExW(0, wc.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, instance, NULL);
	if (!g_hwnd) return 1;

	write_line("ready " HELPER_VERSION "\n");
	HANDLE reader = CreateThread(NULL, 0, stdin_reader, NULL, 0, NULL);
	if (!reader) return 1;
	CloseHandle(reader);

	MSG m;
	while (GetMessageW(&m, NULL, 0, 0) > 0) {
		TranslateMessage(&m);
		DispatchMessageW(&m);
	}
	return 0;
}
