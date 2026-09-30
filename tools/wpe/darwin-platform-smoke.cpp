/* Real WPEPlatform object/lifetime smoke; no WebKit page or mock DOM. */
#include <wpe/wpe-platform.h>
#include <cstdio>
#include <cstring>

struct SmokeDisplay { WPEDisplay parent; };
struct SmokeDisplayClass { WPEDisplayClass parent; };
G_DEFINE_TYPE(SmokeDisplay, smoke_display, WPE_TYPE_DISPLAY)
static void smoke_display_init(SmokeDisplay*) {}
static void smoke_display_class_init(SmokeDisplayClass*) {}

int main()
{
  for (unsigned iteration = 0; iteration < 1000; ++iteration) {
    auto* display = WPE_DISPLAY(g_object_new(smoke_display_get_type(), nullptr));
    gpointer liveDisplay = display;
    g_object_add_weak_pointer(G_OBJECT(display), &liveDisplay);
    guint32 pixels[4] = {0xff123456, 0xffabcdef, 0xff987654, 0xff000000};
    auto* data = g_bytes_new(pixels, sizeof(pixels));
    auto* buffer = wpe_buffer_shm_new(display, 2, 2, WPE_PIXEL_FORMAT_ARGB8888, data, 8);
    g_bytes_unref(data);
    g_object_unref(display);
    // WPEBuffer intentionally holds a GWeakPtr to its display. SHM pixel data
    // remains buffer-owned, but the host must own its display independently.
    if (!buffer || liveDisplay || wpe_buffer_get_display(WPE_BUFFER(buffer)) ||
        wpe_buffer_get_width(WPE_BUFFER(buffer)) != 2 ||
        wpe_buffer_get_height(WPE_BUFFER(buffer)) != 2 || wpe_buffer_shm_get_stride(buffer) != 8)
      return 1;
    gsize length = 0;
    auto* contents = g_bytes_get_data(wpe_buffer_shm_get_data(buffer), &length);
    if (length != sizeof(pixels) || memcmp(contents, pixels, length)) return 2;
    gpointer liveBuffer = buffer;
    g_object_add_weak_pointer(G_OBJECT(buffer), &liveBuffer);
    g_object_unref(buffer);
    if (liveBuffer) return 3;
  }
  puts("PASS real WPEPlatform Darwin display/SHM lifetime: 1000 cycles");
}
