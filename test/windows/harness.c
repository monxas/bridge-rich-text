/*
 * End-to-end harness for bridge-paste-helper.exe on Windows (or Wine).
 *
 * It plays the role of the target application: a focused window that, on
 * Ctrl+V, reads the clipboard the way an editor does and logs what it got.
 * It seeds the clipboard with known content first and checks that the
 * helper restores it afterwards.
 *
 *   harness.exe <helper.exe> <requests-file> <scenario>
 *
 * scenario: "normal" | "steal" (target replaces the clipboard while pasting,
 * so the helper must NOT restore) | "ignore" (target never reads: the helper
 * must report paste_not_observed and still restore).
 *
 * Output: lines on stdout, asserted by test/windows/run-wine.sh.
 */
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>
#include <stdio.h>
#include <string.h>

static UINT cfHtml, cfRtf, cfPrivate;
static const char *scenario;
static HANDLE helperOut;
static volatile LONG responses;
static int expected;

static void print_format(const char *label, UINT fmt) {
	HANDLE h = GetClipboardData(fmt);
	if (!h) {
		printf("%s=<none>\n", label);
		return;
	}
	const char *p = GlobalLock(h);
	printf("%s=%s\n", label, p);
	GlobalUnlock(h);
}

static void print_unicode(const char *label) {
	HANDLE h = GetClipboardData(CF_UNICODETEXT);
	if (!h) {
		printf("%s=<none>\n", label);
		return;
	}
	const WCHAR *w = GlobalLock(h);
	char utf8[256];
	WideCharToMultiByte(CP_UTF8, 0, w, -1, utf8, sizeof utf8, NULL, NULL);
	printf("%s=%s\n", label, utf8);
	GlobalUnlock(h);
}

static void set_text(const WCHAR *text) {
	size_t bytes = (wcslen(text) + 1) * sizeof(WCHAR);
	HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, bytes);
	memcpy(GlobalLock(h), text, bytes);
	GlobalUnlock(h);
	SetClipboardData(CF_UNICODETEXT, h);
}

static LRESULT CALLBACK target_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	if (msg == WM_KEYDOWN && (GetKeyState(VK_CONTROL) & 0x8000)) {
		if (wp == VK_SPACE) printf("target_ctrl_space\n");
		if (wp == 'V') {
			printf("target_ctrl_v\n");
			if (strcmp(scenario, "ignore") != 0 && OpenClipboard(hwnd)) {
				print_format("paste_rtf", cfRtf);
				print_format("paste_html", cfHtml);
				print_unicode("paste_text");
				if (strcmp(scenario, "steal") == 0) {
					EmptyClipboard();
					set_text(L"STOLEN");
				}
				CloseClipboard();
			}
		}
		fflush(stdout);
		return 0;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

static DWORD WINAPI read_helper(LPVOID unused) {
	(void)unused;
	char buf[4096];
	DWORD got;
	while (ReadFile(helperOut, buf, sizeof buf - 1, &got, NULL) && got) {
		buf[got] = 0;
		for (char *line = strtok(buf, "\n"); line; line = strtok(NULL, "\n")) {
			printf("helper: %s\n", line);
			if (strstr(line, " ok") || strstr(line, " error ")) InterlockedIncrement(&responses);
		}
		fflush(stdout);
	}
	return 0;
}

static void pump(DWORD ms) {
	DWORD end = GetTickCount() + ms;
	MSG m;
	while ((LONG)(end - GetTickCount()) > 0) {
		while (PeekMessageW(&m, NULL, 0, 0, PM_REMOVE)) {
			TranslateMessage(&m);
			DispatchMessageW(&m);
		}
		MsgWaitForMultipleObjects(0, NULL, FALSE, 10, QS_ALLINPUT);
	}
}

int main(int argc, char **argv) {
	if (argc != 4) return 2;
	scenario = argv[3];
	cfHtml = RegisterClipboardFormatW(L"HTML Format");
	cfRtf = RegisterClipboardFormatW(L"Rich Text Format");
	cfPrivate = RegisterClipboardFormatW(L"Harness Private Format");

	/* Class name "OpusApp" = what the helper recognises as Microsoft Word. */
	WNDCLASSW wc = {0};
	wc.lpfnWndProc = target_proc;
	wc.hInstance = GetModuleHandleW(NULL);
	wc.lpszClassName = L"OpusApp";
	RegisterClassW(&wc);
	HWND target = CreateWindowExW(0, L"OpusApp", L"Fake Word", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0, 300, 200, NULL, NULL, wc.hInstance, NULL);
	SetForegroundWindow(target);
	SetFocus(target);
	pump(200);
	printf("foreground_is_target=%d\n", GetForegroundWindow() == target);

	/* Seed the clipboard with content the helper must preserve. */
	OpenClipboard(target);
	EmptyClipboard();
	set_text(L"ORIGINAL");
	HGLOBAL priv = GlobalAlloc(GMEM_MOVEABLE, 4);
	memcpy(GlobalLock(priv), "xyz", 4);
	GlobalUnlock(priv);
	SetClipboardData(cfPrivate, priv);
	CloseClipboard();

	/* Start the helper with pipes, exactly like the plugin does. */
	SECURITY_ATTRIBUTES sa = {sizeof sa, NULL, TRUE};
	HANDLE inR, inW, outR, outW;
	CreatePipe(&inR, &inW, &sa, 0);
	CreatePipe(&outR, &outW, &sa, 0);
	SetHandleInformation(inW, HANDLE_FLAG_INHERIT, 0);
	SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
	STARTUPINFOA si = {sizeof si};
	si.dwFlags = STARTF_USESTDHANDLES;
	si.hStdInput = inR;
	si.hStdOutput = outW;
	si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
	PROCESS_INFORMATION pi;
	if (!CreateProcessA(argv[1], NULL, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
		printf("spawn_failed=%lu\n", GetLastError());
		return 1;
	}
	CloseHandle(inR);
	CloseHandle(outW);
	helperOut = outR;
	CreateThread(NULL, 0, read_helper, NULL, 0, NULL);

	FILE *f = fopen(argv[2], "rb");
	char line[8192];
	DWORD written;
	while (f && fgets(line, sizeof line, f)) {
		WriteFile(inW, line, (DWORD)strlen(line), &written, NULL);
		expected++;
	}
	if (f) fclose(f);

	DWORD deadline = GetTickCount() + 15000;
	while (responses < expected && (LONG)(deadline - GetTickCount()) > 0) pump(50);
	pump(300);
	printf("responses=%ld/%d\n", responses, expected);

	OpenClipboard(target);
	print_unicode("after_text");
	print_format("after_private", cfPrivate);
	CloseClipboard();

	CloseHandle(inW); /* EOF: helper must exit by itself */
	DWORD wait = WaitForSingleObject(pi.hProcess, 5000);
	DWORD code = 0;
	GetExitCodeProcess(pi.hProcess, &code);
	printf("helper_exit=%s code=%lu\n", wait == WAIT_OBJECT_0 ? "yes" : "timeout", code);
	fflush(stdout);
	return 0;
}
