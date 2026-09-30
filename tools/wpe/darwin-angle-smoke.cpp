/* Test the port's actual ANGLE/Metal library; no browser or system WebKit. */
#if USE_EPOXY
#include <epoxy/egl.h>
#include <epoxy/gl.h>
#include <EGL/eglext_angle.h>
#else
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#endif
#include <cstdio>
#include <cstdlib>

static void Check(bool value, const char* stage)
{
  if (!value) {
    fprintf(stderr, "FAIL %s (EGL 0x%x)\n", stage, eglGetError());
    exit(1);
  }
}

int main()
{
  auto getDisplay = reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(
    eglGetProcAddress("eglGetPlatformDisplayEXT"));
  Check(getDisplay, "platform display function");
  const EGLint platform[] = {EGL_PLATFORM_ANGLE_TYPE_ANGLE,
                            EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE, EGL_NONE};
  EGLDisplay display = getDisplay(EGL_PLATFORM_ANGLE_ANGLE, nullptr, platform);
  Check(display != EGL_NO_DISPLAY, "Metal display");
  EGLint major, minor;
  Check(eglInitialize(display, &major, &minor), "initialize display");
  Check(eglBindAPI(EGL_OPENGL_ES_API), "bind GLES");
  const EGLint attributes[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8,
    EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
  EGLConfig config;
  EGLint count;
  Check(eglChooseConfig(display, attributes, &config, 1, &count) && count == 1, "choose config");
  const EGLint size[] = {EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE};
  EGLSurface surface = eglCreatePbufferSurface(display, config, size);
  Check(surface != EGL_NO_SURFACE, "pbuffer");
  const EGLint contextAttributes[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
  EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, contextAttributes);
  Check(context != EGL_NO_CONTEXT, "GLES context");
  Check(eglMakeCurrent(display, surface, surface, context), "make current");
  glClearColor(.2f, .4f, .6f, 1.f);
  glClear(GL_COLOR_BUFFER_BIT);
  unsigned char pixel[4] = {};
  glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pixel);
  Check(glGetError() == GL_NO_ERROR, "readback");
  Check(abs(int(pixel[0]) - 51) <= 1 && abs(int(pixel[1]) - 102) <= 1 &&
        abs(int(pixel[2]) - 153) <= 1 && pixel[3] == 255, "pixel value");
  printf("PASS ANGLE Metal EGL %d.%d: %s; pixel %u,%u,%u,%u\n", major, minor,
         glGetString(GL_RENDERER), pixel[0], pixel[1], pixel[2], pixel[3]);
  Check(eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT), "detach context");
  Check(eglDestroyContext(display, context), "destroy context");
  Check(eglDestroySurface(display, surface), "destroy surface");
  Check(eglTerminate(display), "terminate display");
}
