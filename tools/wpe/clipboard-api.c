/* Exercise the public WPE clipboard API without reading the system clipboard. */
#include <wpe/wpe-platform.h>
#include <string.h>

int main(void)
{
    WPEClipboard* clipboard = g_object_new(WPE_TYPE_CLIPBOARD, NULL);
    WPEClipboardContent* content = wpe_clipboard_content_new();
    wpe_clipboard_content_set_text(content, "dummy-password");
    wpe_clipboard_set_content(clipboard, content);
    wpe_clipboard_content_unref(content);
    gsize size = G_MAXSIZE;
    char* text = wpe_clipboard_read_text(clipboard, "text/plain;charset=utf-8", &size);
    g_assert_nonnull(text);
    g_assert_cmpuint(size, ==, strlen("dummy-password"));
    g_assert_cmpmem(text, size, "dummy-password", strlen("dummy-password"));
    g_free(text);
    size = G_MAXSIZE;
    text = wpe_clipboard_read_text(clipboard, "text/html", &size);
    g_assert_null(text);
    g_assert_cmpuint(size, ==, 0);
    wpe_clipboard_set_content(clipboard, NULL);
    size = G_MAXSIZE;
    text = wpe_clipboard_read_text(clipboard, "text/plain;charset=utf-8", &size);
    g_assert_null(text);
    g_assert_cmpuint(size, ==, 0);
    /* The guard diagnoses invalid formats and must initialize its out value. */
    size = G_MAXSIZE;
    text = wpe_clipboard_read_text(clipboard, "", &size);
    g_assert_null(text);
    g_assert_cmpuint(size, ==, 0);
    g_object_unref(clipboard);
    g_print("PASS clipboard text, missing format, cleared owner and invalid format length\n");
    return 0;
}
