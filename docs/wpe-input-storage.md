# WebKit input and container integration

Top-level `about:` pages always use Gecko, including `about:blank`, regardless
of the default engine, site rules, manual WebKit override, or saved engine.
Opening one from a WebKit tab preserves its container, pinning and selection.
The WebKit engine command cannot switch browser-owned pages away from Gecko.
Blank subframes within WebKit documents stay in their parent engine.

Ctrl+F is delivered to WebKit first. An isolated per-frame observer requests
browser find only after the trusted keydown finishes without preventDefault().
This lets editors such as Google Docs use their own document search. Ordinary
pages keep browser find; synthetic events cannot open it. The bridge checks the
live frame token and ignores requests from background tabs. The local regression
fixture exercises handled/unhandled shortcuts; it does not authenticate to Docs.

Middle-click and Ctrl+click link navigation open a background WebKit tab.
Adding Shift selects it. Navigation policy consumes the original decision,
including target=_blank links, to prevent duplicate tabs or replacing the
source page. New tabs retain the source container.

Switching Gecko/WebKit preserves the tab's userContextId in both directions.
The native attach configuration receives that ID. Normal WebKit containers use
separate network sessions and profile directories:

* Default: profile/webkit/{data,cache,cookies.sqlite}
* Container N: profile/webkit/container-N/{data,cache,cookies.sqlite}

Tabs and windows in the same container share its session. Private sessions are
ephemeral and separated from normal storage and other container IDs. The window
retains its sessions until it closes, including when its last WebKit tab closes.
WebKit and Gecko continue to have separate cookie stores; switching engines
does not copy authenticated sessions between them.

Cookie clearing is shared: Clear Recent History and Remove All Cookies also
clear WebKit's normal, container and active private stores. Stored containers
are included even if they have no open tabs, or no WebKit tab has been opened
in this browser run. Only cookies are deleted; localStorage is preserved.
WebKit's soup backend cannot filter cookie deletion by creation time, so a
selected history time range clears **all WebKit cookies**.

Both clear-cookies-on-shutdown and "Keep until I close the browser" wait for
WebKit's asynchronous cookie deletion before profile shutdown completes.
The latter applies independently of the clear-history-on-shutdown setting.
The new-tab (+) button's context menu also offers **New WebKit Tab** and focuses
the address bar after opening it.

WebKit builds default `webkit.enabled` to `true`. Setting it to `false` takes
effect immediately: engine menus and cookie limitation notes disappear, new
navigations use Gecko, and restored WebKit tabs load their saved URL in Gecko.
Existing native tabs remain usable until closed; opening another tab from one
uses Gecko. Cookie cleanup does not start WebKit or touch its stores while the
preference is disabled. Re-enabling restores the entry points without restarting.
Builds configured with `--disable-webkit` omit the preference default, engine
scripts, menus, cookie notes, and their localized strings entirely.


The bundled WPE clipboard fix is documented in
[the downstream patch series](../third_party/webkit/README.md). Updating only the
browser executable while retaining an old WPE library does not include that fix.

Validation with a completed build and an isolated X display:

```sh
DISPLAY=:92 python3 tools/contentengine/run-content-tests.py OBJ input
DISPLAY=:92 python3 tools/contentengine/run-content-tests.py OBJ about
DISPLAY=:92 python3 tools/contentengine/run-content-tests.py OBJ containers
DISPLAY=:92 python3 tools/contentengine/run-content-tests.py OBJ cookies
DISPLAY=:92 python3 tools/contentengine/run-content-tests.py OBJ enabled
DISPLAY=:92 python3 tools/contentengine/run-content-tests.py OBJ frames
DISPLAY=:92 python3 tools/wpe/run-persistence.py OBJ
```

The input suite requires xdotool and xclip and replaces the clipboard on its
display with dummy test values. The container suite checks identity when changing
engines, session metadata, cookie/localStorage separation, sharing within a
container, and persistence after browser restart. The existing persistence suite
checks private session disposal and mixed-engine restore/adoption across windows.
The cookie suite checks dormant stores without opening a view, live normal and
private stores, the cookie-manager button, time-range sanitization, both shutdown
preferences across restarts, preservation of localStorage, and the new-tab menu.

The enabled suite runs against both WebKit and `--disable-webkit` builds. It
checks disabled startup, live UI changes in every cookie dialog, routing, native
attach rejection, session restoration and existing-tab lifetime.
