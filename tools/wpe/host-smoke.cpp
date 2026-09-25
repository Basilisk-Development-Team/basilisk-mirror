/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// Standalone runtime check of the production WPE host. Does not replace XUL tests.
#include "WPEHost.h"
#include <cstdio>
#include <cstring>

struct Test {
  WPEHost* host;
  GtkWidget* window;
  unsigned frames;
  unsigned cycles;
  bool loaded;
  bool failed;
};
static void Create(Test* test)
{
  test->frames = 0;
  test->loaded = false;
  test->host = wpe_host_new();
  if (!test->host) { test->failed = true; gtk_main_quit(); return; }
  test->window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_default_size(GTK_WINDOW(test->window), 640, 480);
  gtk_container_add(GTK_CONTAINER(test->window), test->host->area);
  wpe_host_resize(test->host, 640, 480);
  g_signal_connect(test->host->view, "buffer-rendered",
    G_CALLBACK(+[](WPEView*, WPEBuffer*, gpointer data) {
      ++static_cast<Test*>(data)->frames;
    }), test);
  g_signal_connect(test->host->webView, "load-changed",
    G_CALLBACK(+[](WebKitWebView*, WebKitLoadEvent event, gpointer data) {
      if (event == WEBKIT_LOAD_FINISHED) static_cast<Test*>(data)->loaded = true;
    }), test);
  g_signal_connect(test->host->webView, "web-process-terminated",
    G_CALLBACK(+[](WebKitWebView*, WebKitWebProcessTerminationReason, gpointer data) {
      static_cast<Test*>(data)->failed = true;
      gtk_main_quit();
    }), test);
  gtk_widget_show_all(test->window);
  webkit_web_view_load_html(test->host->webView,
    "<!doctype html><title>WPE host smoke</title>"
    "<style>body{background:#126789;color:white;font:32px sans-serif}</style>"
    "<h1>WPE rendered this page</h1><input autofocus id='input'>",
    "https://example.test/");
}
int main(int argc, char** argv)
{
  gtk_init(&argc, &argv);
  Test test = {};
  Create(&test);
  if (!test.host) return 1;
  guint poll = g_timeout_add(100, [](gpointer data) -> gboolean {
    auto* test = static_cast<Test*>(data);
    if (!test->loaded || !test->frames) return G_SOURCE_CONTINUE;
    const char* title = webkit_web_view_get_title(test->host->webView);
    if (!title || std::strcmp(title, "WPE host smoke")) {
      test->failed = true;
      gtk_main_quit();
      return G_SOURCE_CONTINUE;
    }
    ++test->cycles;
    std::printf("Rendered cycle %u (%u frames)\n", test->cycles, test->frames);
    wpe_host_free(test->host);
    test->host = nullptr;
    gtk_widget_destroy(test->window);
    test->window = nullptr;
    if (test->cycles == 10) gtk_main_quit();
    else Create(test);
    return G_SOURCE_CONTINUE;
  }, &test);
  guint timeout = g_timeout_add_seconds(120, [](gpointer data) -> gboolean {
    static_cast<Test*>(data)->failed = true;
    gtk_main_quit();
    return G_SOURCE_CONTINUE;
  }, &test);
  gtk_main();
  g_source_remove(poll);
  g_source_remove(timeout);
  if (test.host) wpe_host_free(test.host);
  if (test.window) gtk_widget_destroy(test.window);
  if (test.failed || test.cycles != 10) {
    std::fprintf(stderr, "FAIL: WPE load/render/recreate smoke test\n");
    return 1;
  }
  std::puts("PASS: ten WPE load/render/title/destroy cycles");
  return 0;
}
