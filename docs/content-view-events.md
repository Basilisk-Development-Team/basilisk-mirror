# Content view callback contract (version 1)

`nsIContentViewObserver.onContentEvent(view, event, data)` runs on the UXP main
thread. The sender is always `nsIWebContentView`. No backend object crosses this
boundary. Chrome may close a view from a callback; the backend retains its sender
until the callback returns and must tolerate teardown. After destroy, callbacks
are disconnected; queued asynchronous completions must not notify chrome.

Events are project-owned names, not third-party signals. Unknown future events
must be ignored. Subject property bags contain only strings, numbers and booleans,
except the explicit project interface used for an Inspector child view.

| Event | Data and semantics |
| --- | --- |
| content-view-state | Read coherent URI/title/loading/back/forward/zoom/audio getters on sender; may coalesce changes |
| content-view-process-terminated | Recoverable failure; read lastError; pending operations reject, reload permitted |
| content-view-closed | Host should close the child chrome window |
| content-view-inspector | Another nsIWebContentView to host; no Inspector native object |
| content-view-context-menu | Property bag: pageURL, linkURL, linkLabel, imageURL, mediaURL; isLink/isImage/isMedia/isEditable/hasSelection/canInspect; x/y in device pixels. Missing selected text/frame identity must not be inferred |
| content-view-command | String command: chrome navigation/edit/zoom/find/devtools/fullscreen/tab commands |
| content-view-new-window | uri and userGesture; chrome owns disposition and popup policy |
| content-view-route | Actual top-level GET URI; writable handled flag. Chrome schedules switching after callback returns |
| content-view-download-request | Suggested filename, writable destination path; empty path cancels. No channel emulation |
| content-view-download-finished | uri/path/error strings; backend owns transfer and chrome owns UI |
| content-view-find-found / content-view-find-not-found | Backend find result |
| content-view-script-result | id (uint32), json and error strings; correlated asynchronous completion |
| content-view-message | json string from isolated content world |

No trustworthy generic permission-origin, TLS/security-state, favicon or detailed
load-progress callback is advertised yet. A backend must not synthesize missing
information from a shell docshell or a top-level origin. Capability discovery
allows shared chrome to suppress unsupported commands. These constraints apply
unchanged to future WKWebView and Windows adapters.
