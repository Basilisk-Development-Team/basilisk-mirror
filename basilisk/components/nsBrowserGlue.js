/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cr = Components.results;
const Cu = Components.utils;

const XULNS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/AsyncPrefs.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "WindowsUIUtils", "@mozilla.org/windows-ui-utils;1", "nsIWindowsUIUtils");
XPCOMUtils.defineLazyServiceGetter(this, "AlertsService", "@mozilla.org/alerts-service;1", "nsIAlertsService");

// lazy module getters
[
  ["AboutHome", "resource:///modules/AboutHome.jsm"],
  ["AboutNewTab", "resource:///modules/AboutNewTab.jsm"],
  ["AddonManager", "resource://gre/modules/AddonManager.jsm"],
  ["AddonWatcher", "resource://gre/modules/AddonWatcher.jsm"],
  ["AsyncShutdown", "resource://gre/modules/AsyncShutdown.jsm"],
  ["AutoCompletePopup", "resource://gre/modules/AutoCompletePopup.jsm"],
  ["BookmarkHTMLUtils", "resource://gre/modules/BookmarkHTMLUtils.jsm"],
  ["BookmarkJSONUtils", "resource://gre/modules/BookmarkJSONUtils.jsm"],
  ["ContentClick", "resource:///modules/ContentClick.jsm"],
  ["ContentPrefServiceParent", "resource://gre/modules/ContentPrefServiceParent.jsm"],
  ["ContentSearch", "resource:///modules/ContentSearch.jsm"],
  ["DateTimePickerHelper", "resource://gre/modules/DateTimePickerHelper.jsm"],
  ["Feeds", "resource:///modules/Feeds.jsm"],
  ["FileUtils", "resource://gre/modules/FileUtils.jsm"],
  ["FormValidationHandler", "resource:///modules/FormValidationHandler.jsm"],
  ["Integration", "resource://gre/modules/Integration.jsm"],
  ["LightweightThemeManager", "resource://gre/modules/LightweightThemeManager.jsm"],
  ["LoginHelper", "resource://gre/modules/LoginHelper.jsm"],
  ["LoginManagerParent", "resource://gre/modules/LoginManagerParent.jsm"],
  ["NetUtil", "resource://gre/modules/NetUtil.jsm"],
  ["NewTabMessages", "resource:///modules/NewTabMessages.jsm"],
  ["NewTabUtils", "resource://gre/modules/NewTabUtils.jsm"],
  ["OS", "resource://gre/modules/osfile.jsm"],
  ["PageThumbs", "resource://gre/modules/PageThumbs.jsm"],
  ["PdfJs", "resource://pdf.js/PdfJs.jsm"],
  ["PermissionUI", "resource:///modules/PermissionUI.jsm"],
  ["PlacesBackups", "resource://gre/modules/PlacesBackups.jsm"],
  ["PlacesUtils", "resource://gre/modules/PlacesUtils.jsm"],
  ["PluralForm", "resource://gre/modules/PluralForm.jsm"],
  ["PrivateBrowsingUtils", "resource://gre/modules/PrivateBrowsingUtils.jsm"],
  ["ProcessHangMonitor", "resource:///modules/ProcessHangMonitor.jsm"],
  ["ReaderParent", "resource:///modules/ReaderParent.jsm"],
  ["RecentWindow", "resource:///modules/RecentWindow.jsm"],
  ["RemotePrompt", "resource:///modules/RemotePrompt.jsm"],
  ["SessionStore", "resource:///modules/sessionstore/SessionStore.jsm"],
  ["ShellService", "resource:///modules/ShellService.jsm"],
  ["TabCrashHandler", "resource:///modules/ContentCrashHandlers.jsm"],
  ["Task", "resource://gre/modules/Task.jsm"],
  ["URLBarZoom", "resource:///modules/URLBarZoom.jsm"],
  ["UserAgentOverrides", "resource://gre/modules/UserAgentOverrides.jsm"],
  ["WebChannel", "resource://gre/modules/WebChannel.jsm"],
  ["WindowsRegistry", "resource://gre/modules/WindowsRegistry.jsm"],
  ["webrtcUI", "resource:///modules/webrtcUI.jsm"],
].forEach(([name, resource]) => XPCOMUtils.defineLazyModuleGetter(this, name, resource));

XPCOMUtils.defineLazyGetter(this, "gBrandBundle", function() {
  return Services.strings.createBundle('chrome://branding/locale/brand.properties');
});

XPCOMUtils.defineLazyGetter(this, "gBrowserBundle", function() {
  return Services.strings.createBundle('chrome://browser/locale/browser.properties');
});

// Seconds of idle before trying to create a bookmarks backup.
const BOOKMARKS_BACKUP_IDLE_TIME_SEC = 8 * 60;
// Minimum interval between backups.  We try to not create more than one backup
// per interval.
const BOOKMARKS_BACKUP_MIN_INTERVAL_DAYS = 1;
// Maximum interval between backups.  If the last backup is older than these
// days we will try to create a new one more aggressively.
const BOOKMARKS_BACKUP_MAX_INTERVAL_DAYS = 3;

// Use users' idle time to unlink ghost windows and clean up memory.
// Trigger this by default every 5 minutes.
const GHOSTBUSTER_INTERVAL = 5 * 60;

// Factory object
const BrowserGlueServiceFactory = {
  _instance: null,
  createInstance: function(outer, iid) {
    if (outer != null)
      throw Components.results.NS_ERROR_NO_AGGREGATION;
    return this._instance == null ?
      this._instance = new BrowserGlue() : this._instance;
  }
};

// Constructor

function BrowserGlue() {
  XPCOMUtils.defineLazyServiceGetter(this, "_idleService",
                                     "@mozilla.org/widget/idleservice;1",
                                     "nsIIdleService");

  XPCOMUtils.defineLazyServiceGetter(this, "_ghostBusterService",
                                     "@mozilla.org/widget/idleservice;1",
                                     "nsIIdleService");

  XPCOMUtils.defineLazyGetter(this, "_distributionCustomizer", function() {
                                Cu.import("resource:///modules/distribution.js");
                                return new DistributionCustomizer();
                              });

  XPCOMUtils.defineLazyGetter(this, "_sanitizer",
    function() {
      let sanitizerScope = {};
      Services.scriptloader.loadSubScript("chrome://browser/content/sanitize.js", sanitizerScope);
      return sanitizerScope.Sanitizer;
    });

  this._init();
}

/*
 * OS X has the concept of zero-window sessions and therefore ignores the
 * browser-lastwindow-close-* topics.
 */
#ifdef XP_MACOSX
const OBSERVE_LASTWINDOW_CLOSE_TOPICS = false;
#else
const OBSERVE_LASTWINDOW_CLOSE_TOPICS = true;
#endif

BrowserGlue.prototype = {
  _saveSession: false,
  _isPlacesInitObserver: false,
  _isPlacesLockedObserver: false,
  _isPlacesShutdownObserver: false,
  _isPlacesDatabaseLocked: false,
  _migrationImportsDefaultBookmarks: false,
  _isGhostBusterObserver: false,

  _setPrefToSaveSession: function(aForce) {
    if (!this._saveSession && !aForce)
      return;

    Services.prefs.setBoolPref("browser.sessionstore.resume_session_once", true);

    // This method can be called via [NSApplication terminate:] on Mac, which
    // ends up causing prefs not to be flushed to disk, so we need to do that
    // explicitly here. See bug 497652.
    Services.prefs.savePrefFile(null);
  },

#ifdef MOZ_SERVICES_SYNC
  _setSyncAutoconnectDelay: function() {
    // Assume that a non-zero value for services.sync.autoconnectDelay should override
    if (Services.prefs.prefHasUserValue("services.sync.autoconnectDelay")) {
      let prefDelay = Services.prefs.getIntPref("services.sync.autoconnectDelay");

      if (prefDelay > 0)
        return;
    }

    // delays are in seconds
    const MAX_DELAY = 300;
    let delay = 3;
    let browserEnum = Services.wm.getEnumerator("navigator:browser");
    while (browserEnum.hasMoreElements()) {
      delay += browserEnum.getNext().gBrowser.tabs.length;
    }
    delay = delay <= MAX_DELAY ? delay : MAX_DELAY;

    Cu.import("resource://services-sync/main.js");
    Weave.Service.scheduler.delayedAutoConnect(delay);
  },
#endif

  // nsIObserver implementation
  observe: function(subject, topic, data) {
    switch (topic) {
      case "notifications-open-settings":
        this._openPreferences("content");
        break;
      case "prefservice:after-app-defaults":
        this._onAppDefaults();
        break;
      case "final-ui-startup":
        this._finalUIStartup();
        break;
      case "browser-delayed-startup-finished":
        this._onFirstWindowLoaded(subject);
        Services.obs.removeObserver(this, "browser-delayed-startup-finished");
        break;
      case "sessionstore-windows-restored":
        this._onWindowsRestored();
        break;
      case "browser:purge-session-history":
        // reset the console service's error buffer
        Services.console.logStringMessage(null); // clear the console (in case it's open)
        Services.console.reset();
        break;
      case "restart-in-safe-mode":
        this._onSafeModeRestart();
        break;
      case "quit-application-requested":
        this._onQuitRequest(subject, data);
        break;
      case "quit-application-granted":
        this._onQuitApplicationGranted();
        break;
      case "browser-lastwindow-close-requested":
        if (OBSERVE_LASTWINDOW_CLOSE_TOPICS) {
          // The application is not actually quitting, but the last full browser
          // window is about to be closed.
          this._onQuitRequest(subject, "lastwindow");
        }
        break;
      case "browser-lastwindow-close-granted":
        if (OBSERVE_LASTWINDOW_CLOSE_TOPICS) {
          this._setPrefToSaveSession();
        }
        break;
#ifdef MOZ_SERVICES_SYNC
      case "weave:service:ready":
        this._setSyncAutoconnectDelay();
        break;
      case "weave:engine:clients:display-uri":
        this._onDisplaySyncURI(subject);
         break;
#endif
      case "session-save":
        this._setPrefToSaveSession(true);
        subject.QueryInterface(Ci.nsISupportsPRBool);
        subject.data = true;
        break;
      case "places-init-complete":
        if (!this._migrationImportsDefaultBookmarks)
          this._initPlaces(false);

        Services.obs.removeObserver(this, "places-init-complete");
        this._isPlacesInitObserver = false;
        // no longer needed, since history was initialized completely.
        Services.obs.removeObserver(this, "places-database-locked");
        this._isPlacesLockedObserver = false;
        break;
      case "places-database-locked":
        this._isPlacesDatabaseLocked = true;
        // Stop observing, so further attempts to load history service
        // will not show the prompt.
        Services.obs.removeObserver(this, "places-database-locked");
        this._isPlacesLockedObserver = false;
        break;
      case "idle":
        this._backupBookmarks();
        if (this._ghostBusterService.idleTime > GHOSTBUSTER_INTERVAL * 1000) {
          if (Services.prefs.getBoolPref("browser.ghostbuster.enabled", true)) {
            Cu.unlinkGhostWindows();
            Cu.forceGC();
#ifdef DEBUG
            dump("Unlinking ghost windows + GC has run on idle.\n");
#endif
          }
        }
        break;
      case "distribution-customization-complete":
        Services.obs.removeObserver(this, "distribution-customization-complete");
        // Customization has finished, we don't need the customizer anymore.
        delete this._distributionCustomizer;
        break;
      case "browser-glue-test": // used by tests
        if (data == "post-update-notification") {
          if (Services.prefs.prefHasUserValue("app.update.postupdate"))
            this._showUpdateNotification();
        }
        else if (data == "force-ui-migration") {
          this._migrateUI();
        }
        else if (data == "force-distribution-customization") {
          this._distributionCustomizer.applyPrefDefaults();
          this._distributionCustomizer.applyCustomizations();
          // To apply distribution bookmarks use "places-init-complete".
        }
        else if (data == "force-places-init") {
          this._initPlaces(false);
        }
        else if (data == "smart-bookmarks-init") {
          this.ensurePlacesDefaultQueriesInitialized().then(() => {
            Services.obs.notifyObservers(null, "test-smart-bookmarks-done", null);
          });
        }
        break;
      case "initial-migration-will-import-default-bookmarks":
        this._migrationImportsDefaultBookmarks = true;
        break;
      case "initial-migration-did-import-default-bookmarks":
        this._initPlaces(true);
        break;
      case "handle-xul-text-link":
        let linkHandled = subject.QueryInterface(Ci.nsISupportsPRBool);
        if (!linkHandled.data) {
          let win = RecentWindow.getMostRecentBrowserWindow();
          if (win) {
            data = JSON.parse(data);
            let where = win.whereToOpenLink(data);
            // Preserve legacy behavior of non-modifier left-clicks
            // opening in a new selected tab.
            if (where == "current") {
              where = "tab";
            }
            win.openUILinkIn(data.href, where);
            linkHandled.data = true;
          }
        }
        break;
      case "profile-before-change":
         // Any component depending on Places should be finalized in
         // _onPlacesShutdown.  Any component that doesn't need to act after
         // the UI has gone should be finalized in _onQuitApplicationGranted.
        this._dispose();
        break;
      case "keyword-search":
        // This notification is broadcast by the docshell when it "fixes up" a
        // URI that it's been asked to load into a keyword search.
        let engine = null;
        try {
          engine = subject.QueryInterface(Ci.nsISearchEngine);
        } catch (ex) {
          Cu.reportError(ex);
        }
        break;
      case "browser-search-engine-modified":
        // Ensure we cleanup the hiddenOneOffs pref when removing
        // an engine, and that newly added engines are visible.
        if (data == "engine-added" || data == "engine-removed") {
          let engineName = subject.QueryInterface(Ci.nsISearchEngine).name;
          let Preferences =
            Cu.import("resource://gre/modules/Preferences.jsm", {}).Preferences;
          let pref = Preferences.get("browser.search.hiddenOneOffs");
          let hiddenList = pref ? pref.split(",") : [];
          hiddenList = hiddenList.filter(x => x !== engineName);
          Preferences.set("browser.search.hiddenOneOffs",
                          hiddenList.join(","));
        }
        break;
      case "flash-plugin-hang":
        this._handleFlashHang();
        break;
      case "xpi-signature-changed":
        let disabledAddons = JSON.parse(data).disabled;
        AddonManager.getAddonsByIDs(disabledAddons, (addons) => {
          for (let addon of addons) {
            if (addon.type != "experiment") {
              this._notifyUnsignedAddonsDisabled();
              break;
            }
          }
        });
        break;
      case "autocomplete-did-enter-text":
        break;
      case "test-initialize-sanitizer":
        this._sanitizer.onStartup();
        break;
      case AddonWatcher.TOPIC_SLOW_ADDON_DETECTED:
        this._notifySlowAddon(data);
        break;
    }
  },

  // initialization (called on application startup)
  _init: function() {
    let os = Services.obs;
    os.addObserver(this, "notifications-open-settings", false);
    os.addObserver(this, "prefservice:after-app-defaults", false);
    os.addObserver(this, "final-ui-startup", false);
    os.addObserver(this, "browser-delayed-startup-finished", false);
    os.addObserver(this, "sessionstore-windows-restored", false);
    os.addObserver(this, "browser:purge-session-history", false);
    os.addObserver(this, "quit-application-requested", false);
    os.addObserver(this, "quit-application-granted", false);
    if (OBSERVE_LASTWINDOW_CLOSE_TOPICS) {
      os.addObserver(this, "browser-lastwindow-close-requested", false);
      os.addObserver(this, "browser-lastwindow-close-granted", false);
    }
#ifdef MOZ_SERVICES_SYNC
    os.addObserver(this, "weave:service:ready", false);
    os.addObserver(this, "weave:engine:clients:display-uri", false);
#endif
    os.addObserver(this, "session-save", false);
    os.addObserver(this, "places-init-complete", false);
    this._isPlacesInitObserver = true;
    os.addObserver(this, "places-database-locked", false);
    this._isPlacesLockedObserver = true;
    os.addObserver(this, "distribution-customization-complete", false);
    os.addObserver(this, "handle-xul-text-link", false);
    os.addObserver(this, "profile-before-change", false);
    os.addObserver(this, "browser-search-engine-modified", false);
    os.addObserver(this, "restart-in-safe-mode", false);
    os.addObserver(this, "flash-plugin-hang", false);
    os.addObserver(this, "xpi-signature-changed", false);
    os.addObserver(this, "autocomplete-did-enter-text", false);

    this._flashHangCount = 0;
    this._firstWindowReady = new Promise(resolve => this._firstWindowLoaded = resolve);
  },

  // cleanup (called on application shutdown)
  _dispose: function() {
    let os = Services.obs;
    os.removeObserver(this, "notifications-open-settings");
    os.removeObserver(this, "prefservice:after-app-defaults");
    os.removeObserver(this, "final-ui-startup");
    os.removeObserver(this, "sessionstore-windows-restored");
    os.removeObserver(this, "browser:purge-session-history");
    os.removeObserver(this, "quit-application-requested");
    os.removeObserver(this, "quit-application-granted");
    os.removeObserver(this, "restart-in-safe-mode");
    if (OBSERVE_LASTWINDOW_CLOSE_TOPICS) {
      os.removeObserver(this, "browser-lastwindow-close-requested");
      os.removeObserver(this, "browser-lastwindow-close-granted");
    }
#ifdef MOZ_SERVICES_SYNC
    os.removeObserver(this, "weave:service:ready");
    os.removeObserver(this, "weave:engine:clients:display-uri");
#endif
    os.removeObserver(this, "session-save");
    if (this._bookmarksBackupIdleTime) {
      this._idleService.removeIdleObserver(this, this._bookmarksBackupIdleTime);
      delete this._bookmarksBackupIdleTime;
    }
    if (this._isPlacesInitObserver)
      os.removeObserver(this, "places-init-complete");
    if (this._isPlacesLockedObserver)
      os.removeObserver(this, "places-database-locked");
    os.removeObserver(this, "handle-xul-text-link");
    os.removeObserver(this, "profile-before-change");
    os.removeObserver(this, "browser-search-engine-modified");
    os.removeObserver(this, "flash-plugin-hang");
    os.removeObserver(this, "xpi-signature-changed");
    os.removeObserver(this, "autocomplete-did-enter-text");
  },

  _onAppDefaults: function() {
    // apply distribution customizations (prefs)
    // other customizations are applied in _finalUIStartup()
    this._distributionCustomizer.applyPrefDefaults();
  },

  _notifySlowAddon: function(addonId) {
    let addonCallback = function(addon) {
      if (!addon) {
        Cu.reportError("couldn't look up addon: " + addonId);
        return;
      }
      let win = RecentWindow.getMostRecentBrowserWindow();

      if (!win) {
        return;
      }

      let brandBundle = win.document.getElementById("bundle_brand");
      let brandShortName = brandBundle.getString("brandShortName");
      let message = win.gNavigatorBundle.getFormattedString("addonwatch.slow", [addon.name, brandShortName]);
      let notificationBox = win.document.getElementById("global-notificationbox");
      let notificationId = 'addon-slow:' + addonId;
      let notification = notificationBox.getNotificationWithValue(notificationId);

      // Monitor the response of users
      const STATE_WARNING_DISPLAYED = 0;
      const STATE_USER_PICKED_DISABLE = 1;
      const STATE_USER_PICKED_IGNORE_FOR_NOW = 2;
      const STATE_USER_PICKED_IGNORE_FOREVER = 3;
      const STATE_USER_CLOSED_NOTIFICATION = 4;

      let complete = false;
      let start = Date.now();
      let done = function(response) {
        // Only report the first reason for closing.
        if (complete) {
          return;
        }
        complete = true;
      };

      if (notification) {
        notification.label = message;
      } else {
        let buttons = [
          {
            label: win.gNavigatorBundle.getFormattedString("addonwatch.disable.label", [addon.name]),
            accessKey: "", // workaround for bug 1192901
            callback: function() {
              done(STATE_USER_PICKED_DISABLE);
              addon.userDisabled = true;
              if (addon.pendingOperations == addon.PENDING_NONE) {
                return;
              }
              let restartMessage = win.gNavigatorBundle.getFormattedString("addonwatch.restart.message", [addon.name, brandShortName]);
              let restartButton = [
                {
                  label: win.gNavigatorBundle.getFormattedString("addonwatch.restart.label", [brandShortName]),
                  accessKey: win.gNavigatorBundle.getString("addonwatch.restart.accesskey"),
                  callback: function() {
                    let appStartup = Cc["@mozilla.org/toolkit/app-startup;1"]
                      .getService(Ci.nsIAppStartup);
                    appStartup.quit(appStartup.eForceQuit | appStartup.eRestart);
                  }
                }
              ];
              const priority = notificationBox.PRIORITY_WARNING_MEDIUM;
              notificationBox.appendNotification(restartMessage, "restart-" + addonId, "",
                                                 priority, restartButton);
            }
          },
          {
            label: win.gNavigatorBundle.getString("addonwatch.ignoreSession.label"),
            accessKey: win.gNavigatorBundle.getString("addonwatch.ignoreSession.accesskey"),
            callback: function() {
              done(STATE_USER_PICKED_IGNORE_FOR_NOW);
              AddonWatcher.ignoreAddonForSession(addonId);
            }
          },
          {
            label: win.gNavigatorBundle.getString("addonwatch.ignorePerm.label"),
            accessKey: win.gNavigatorBundle.getString("addonwatch.ignorePerm.accesskey"),
            callback: function() {
              done(STATE_USER_PICKED_IGNORE_FOREVER);
              AddonWatcher.ignoreAddonPermanently(addonId);
            }
          },
        ];

        const priority = notificationBox.PRIORITY_WARNING_MEDIUM;
        notification = notificationBox.appendNotification(
          message, notificationId, "",
          priority, buttons,
          function(topic) {
            if (topic == "removed") {
              // Other callbacks are called before this one and only the first
              // call to `done` is taken into account, so if this call to `done`
              // gets through, this means that the user has closed the notification
              // manually.
              done(STATE_USER_CLOSED_NOTIFICATION);
            }
          });
      }
    };
    AddonManager.getAddonByID(addonId, addonCallback);
  },

  // runs on startup, before the first command line handler is invoked
  // (i.e. before the first window is opened)
  _finalUIStartup: function() {
    this._sanitizer.onStartup();
    // check if we're in safe mode
    if (Services.appinfo.inSafeMode) {
      Services.ww.openWindow(null, "chrome://browser/content/safeMode.xul",
                             "_blank", "chrome,centerscreen,modal,resizable=no", null);
    }

    // apply distribution customizations
    // prefs are applied in _onAppDefaults()
    this._distributionCustomizer.applyCustomizations();

    // handle any UI migration
    this._migrateUI();

    // This is support code for the location bar search suggestions; passing
    // from opt-in to opt-out should respect the user's choice, thus we need
    // to cache that choice in a pref for future use.
    // Note: this is not in migrateUI because we need to uplift it. This
    // code is also short-lived, since we can remove it as soon as opt-out
    // search suggestions shipped in release (Bug 1344928).
    try {
      let urlbarPrefs = Services.prefs.getBranch("browser.urlbar.");
      if (!urlbarPrefs.prefHasUserValue("searchSuggestionsChoice") &&
          urlbarPrefs.getBoolPref("userMadeSearchSuggestionsChoice")) {
        urlbarPrefs.setBoolPref("searchSuggestionsChoice",
                                urlbarPrefs.getBoolPref("suggest.searches"));
      }
    } catch (ex) { /* missing any of the prefs is not critical */ }

    UserAgentOverrides.init();
    
    PageThumbs.init();
    webrtcUI.init();
    AboutHome.init();

    NewTabUtils.init();
    AboutNewTab.init();

    NewTabMessages.init();

    SessionStore.init();
    ContentSearch.init();
    FormValidationHandler.init();

    ContentClick.init();
    RemotePrompt.init();
    Feeds.init();
    ContentPrefServiceParent.init();

    LoginManagerParent.init();
    ReaderParent.init();
    URLBarZoom.init();

    // Ensure we keep track of places/pw-mananager undo by init'ing this early.
    Cu.import("resource:///modules/AutoMigrate.jsm");

    TabCrashHandler.init();

    Services.obs.notifyObservers(null, "browser-ui-startup-complete", "");
  },

  _checkForOldBuildUpdates: function () {
#ifdef MOZ_UPDATER
    // check for update if our build is old
    if (Services.prefs.getBoolPref("app.update.enabled") &&
        Services.prefs.getBoolPref("app.update.checkInstallTime")) {

      let buildID = Services.appinfo.appBuildID;
      let today = new Date().getTime();
      let buildDate = new Date(buildID.slice(0, 4),     // year
                               buildID.slice(4, 6) - 1, // months are zero-based.
                               buildID.slice(6, 8),     // day
                               buildID.slice(8, 10),    // hour
                               buildID.slice(10, 12),   // min
                               buildID.slice(12, 14))   // ms
      .getTime();

      const millisecondsIn24Hours = 86400000;
      let acceptableAge = Services.prefs.getIntPref("app.update.checkInstallTime.days") * millisecondsIn24Hours;

      if (buildDate + acceptableAge < today) {
        Cc["@mozilla.org/updates/update-service;1"].getService(Ci.nsIApplicationUpdateService).checkForBackgroundUpdates();
      }
    }
#endif
  },

  _onSafeModeRestart: function() {
    // prompt the user to confirm
    let strings = gBrowserBundle;
    let promptTitle = strings.GetStringFromName("safeModeRestartPromptTitle");
    let promptMessage = strings.GetStringFromName("safeModeRestartPromptMessage");
    let restartText = strings.GetStringFromName("safeModeRestartButton");
    let buttonFlags = (Services.prompt.BUTTON_POS_0 *
                       Services.prompt.BUTTON_TITLE_IS_STRING) +
                      (Services.prompt.BUTTON_POS_1 *
                       Services.prompt.BUTTON_TITLE_CANCEL) +
                      Services.prompt.BUTTON_POS_0_DEFAULT;

    let rv = Services.prompt.confirmEx(null, promptTitle, promptMessage,
                                       buttonFlags, restartText, null, null,
                                       null, {});
    if (rv != 0)
      return;

    let cancelQuit = Cc["@mozilla.org/supports-PRBool;1"]
                       .createInstance(Ci.nsISupportsPRBool);
    Services.obs.notifyObservers(cancelQuit, "quit-application-requested", "restart");

    if (!cancelQuit.data) {
      Services.startup.restartInSafeMode(Ci.nsIAppStartup.eAttemptQuit);
    }
  },

  _trackSlowStartup: function () {
    if (Services.startup.interrupted ||
        Services.prefs.getBoolPref("browser.slowStartup.notificationDisabled"))
      return;

    let currentTime = Date.now() - Services.startup.getStartupInfo().process;
    let averageTime = 0;
    let samples = 0;
    try {
      averageTime = Services.prefs.getIntPref("browser.slowStartup.averageTime");
      samples = Services.prefs.getIntPref("browser.slowStartup.samples");
    } catch (e) { }

    let totalTime = (averageTime * samples) + currentTime;
    samples++;
    averageTime = totalTime / samples;

    if (samples >= Services.prefs.getIntPref("browser.slowStartup.maxSamples")) {
      if (averageTime > Services.prefs.getIntPref("browser.slowStartup.timeThreshold"))
        this._calculateProfileAgeInDays().then(this._showSlowStartupNotification, null);
      averageTime = 0;
      samples = 0;
    }

    Services.prefs.setIntPref("browser.slowStartup.averageTime", averageTime);
    Services.prefs.setIntPref("browser.slowStartup.samples", samples);
  },

  _calculateProfileAgeInDays: Task.async(function* () {
    let ProfileAge = Cu.import("resource://gre/modules/ProfileAge.jsm", {}).ProfileAge;
    let profileAge = new ProfileAge(null, null);

    let creationDate = yield profileAge.created;
    let resetDate = yield profileAge.reset;

    // if the profile was reset, consider the
    // reset date for its age.
    let profileDate = resetDate || creationDate;

    const ONE_DAY = 24 * 60 * 60 * 1000;
    return (Date.now() - profileDate) / ONE_DAY;
  }),

  _showSlowStartupNotification: function (profileAge) {
    if (profileAge < 90) // 3 months
      return;

    let win = RecentWindow.getMostRecentBrowserWindow();
    if (!win)
      return;

    let productName = gBrandBundle.GetStringFromName("brandFullName");
    let message = win.gNavigatorBundle.getFormattedString("slowStartup.message", [productName]);

    let buttons = [
      {
        label:     win.gNavigatorBundle.getString("slowStartup.helpButton.label"),
        accessKey: win.gNavigatorBundle.getString("slowStartup.helpButton.accesskey"),
        callback: function () {
          win.openUILinkIn("https://support.mozilla.org/kb/reset-firefox-easily-fix-most-problems", "tab");
        }
      },
      {
        label:     win.gNavigatorBundle.getString("slowStartup.disableNotificationButton.label"),
        accessKey: win.gNavigatorBundle.getString("slowStartup.disableNotificationButton.accesskey"),
        callback: function () {
          Services.prefs.setBoolPref("browser.slowStartup.notificationDisabled", true);
        }
      }
    ];

    let nb = win.document.getElementById("global-notificationbox");
    nb.appendNotification(message, "slow-startup",
                          "chrome://browser/skin/slowStartup-16.png",
                          nb.PRIORITY_INFO_LOW, buttons);
  },

  /**
   * Show a notification bar offering a reset.
   *
   * @param reason
   *        String of either "unused" or "uninstall", specifying the reason
   *        why a profile reset is offered.
   */
  _resetProfileNotification: function (reason) {
    let win = RecentWindow.getMostRecentBrowserWindow();
    if (!win)
      return;

    Cu.import("resource://gre/modules/ResetProfile.jsm");
    if (!ResetProfile.resetSupported())
      return;

    let productName = gBrandBundle.GetStringFromName("brandShortName");
    let resetBundle = Services.strings
                              .createBundle("chrome://global/locale/resetProfile.properties");

    let message;
    if (reason == "unused") {
      message = resetBundle.formatStringFromName("resetUnusedProfile.message", [productName], 1);
    } else if (reason == "uninstall") {
      message = resetBundle.formatStringFromName("resetUninstalled.message", [productName], 1);
    } else {
      throw new Error(`Unknown reason (${reason}) given to _resetProfileNotification.`);
    }
    let buttons = [
      {
        label:     resetBundle.formatStringFromName("refreshProfile.resetButton.label", [productName], 1),
        accessKey: resetBundle.GetStringFromName("refreshProfile.resetButton.accesskey"),
        callback: function () {
          ResetProfile.openConfirmationDialog(win);
        }
      },
    ];

    let nb = win.document.getElementById("global-notificationbox");
    nb.appendNotification(message, "reset-profile-notification",
                          "chrome://global/skin/icons/question-16.png",
                          nb.PRIORITY_INFO_LOW, buttons);
  },

  _notifyUnsignedAddonsDisabled: function () {
    let win = RecentWindow.getMostRecentBrowserWindow();
    if (!win)
      return;

    let message = win.gNavigatorBundle.getString("unsignedAddonsDisabled.message");
    let buttons = [
      {
        label:     win.gNavigatorBundle.getString("unsignedAddonsDisabled.learnMore.label"),
        accessKey: win.gNavigatorBundle.getString("unsignedAddonsDisabled.learnMore.accesskey"),
        callback: function () {
          win.BrowserOpenAddonsMgr("addons://list/extension?unsigned=true");
        }
      },
    ];

    let nb = win.document.getElementById("high-priority-global-notificationbox");
    nb.appendNotification(message, "unsigned-addons-disabled", "",
                          nb.PRIORITY_WARNING_MEDIUM, buttons);
  },

  // the first browser window has finished initializing
  _onFirstWindowLoaded: function(aWindow) {
    // Initialize PdfJs when running in-process and remote. This only
    // happens once since PdfJs registers global hooks. If the PdfJs
    // extension is installed the init method below will be overridden
    // leaving initialization to the extension.
    // parent only: configure default prefs, set up pref observers, register
    // pdf content handler, and initializes parent side message manager
    // shim for privileged api access.
    PdfJs.init(true);
    // child only: similar to the call above for parent - register content
    // handler and init message manager child shim for privileged api access.
    // With older versions of the extension installed, this load will fail
    // passively.
    Services.ppmm.loadProcessScript("resource://pdf.js/pdfjschildbootstrap.js", true);

#ifdef XP_WIN
    // For Windows 7, initialize the jump list module.
    const WINTASKBAR_CONTRACTID = "@mozilla.org/windows-taskbar;1";
    if (WINTASKBAR_CONTRACTID in Cc &&
        Cc[WINTASKBAR_CONTRACTID].getService(Ci.nsIWinTaskbar).available) {
      let temp = {};
      Cu.import("resource:///modules/WindowsJumpLists.jsm", temp);
      temp.WinTaskbarJumpList.startup();
    }
#endif

    ProcessHangMonitor.init();

    // A channel for "remote troubleshooting" code...
    let channel = new WebChannel("remote-troubleshooting", "remote-troubleshooting");
    channel.listen((id, data, target) => {
      if (data.command == "request") {
        let {Troubleshoot} = Cu.import("resource://gre/modules/Troubleshoot.jsm", {});
        Troubleshoot.snapshot(data => {
          // for privacy we remove crash IDs and all preferences (but bug 1091944
          // exists to expose prefs once we are confident of privacy implications)
          delete data.crashes;
          delete data.modifiedPreferences;
          channel.send(data, target);
        });
      }
    });

    this._trackSlowStartup();

    // Initialize ghost window idle observer.
    if (!this._isGhostBusterObserver) {
      this._ghostBusterService.addIdleObserver(this, GHOSTBUSTER_INTERVAL);
      // Prevent re-entry.
      this._isGhostBusterObserver = true;
    }

    // Offer to reset a user's profile if it hasn't been used for 60 days.
    const OFFER_PROFILE_RESET_INTERVAL_MS = 60 * 24 * 60 * 60 * 1000;
    let lastUse = Services.appinfo.replacedLockTime;
    let disableResetPrompt = Services.prefs.getBoolPref("browser.disableResetPrompt", false);

    if (!disableResetPrompt && lastUse &&
        Date.now() - lastUse >= OFFER_PROFILE_RESET_INTERVAL_MS) {
      this._resetProfileNotification("unused");
#ifdef XP_WIN
    } else if (!disableResetPrompt) {
      // Check if we were just re-installed and offer Firefox Reset
      let updateChannel;
      try {
        updateChannel = Cu.import("resource://gre/modules/UpdateUtils.jsm", {}).UpdateUtils.UpdateChannel;
      } catch (ex) {}
      if (updateChannel) {
        let uninstalledValue =
          WindowsRegistry.readRegKey(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
                                     "Software\\Mozilla\\Firefox",
                                     `Uninstalled-${updateChannel}`);
        let removalSuccessful =
          WindowsRegistry.removeRegKey(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
                                       "Software\\Mozilla\\Firefox",
                                       `Uninstalled-${updateChannel}`);
        if (removalSuccessful && uninstalledValue == "True") {
          this._resetProfileNotification("uninstall");
        }
      }
#endif
    }

    this._checkForOldBuildUpdates();

    AutoCompletePopup.init();
    DateTimePickerHelper.init();

    this._firstWindowLoaded();
  },

  /**
   * Application shutdown handler.
   */
  _onQuitApplicationGranted: function () {
    // This pref must be set here because SessionStore will use its value
    // on quit-application.
    this._setPrefToSaveSession();

    // Call trackStartupCrashEnd here in case the delayed call on startup hasn't
    // yet occurred (see trackStartupCrashEnd caller in browser.js).
    try {
      let appStartup = Cc["@mozilla.org/toolkit/app-startup;1"]
                         .getService(Ci.nsIAppStartup);
      appStartup.trackStartupCrashEnd();
    } catch (e) {
      Cu.reportError("Could not end startup crash tracking in quit-application-granted: " + e);
    }

    if (this._bookmarksBackupIdleTime) {
      this._idleService.removeIdleObserver(this, this._bookmarksBackupIdleTime);
      delete this._bookmarksBackupIdleTime;
    }

    UserAgentOverrides.uninit();
    PageThumbs.uninit();
    NewTabMessages.uninit();
    AboutNewTab.uninit();
    webrtcUI.uninit();
    FormValidationHandler.uninit();
    AutoCompletePopup.uninit();
    DateTimePickerHelper.uninit();
  },

  // All initial windows have opened.
  _onWindowsRestored: function() {
    // Show update notification, if needed.
    if (Services.prefs.prefHasUserValue("app.update.postupdate"))
      this._showUpdateNotification();

    // Load the "more info" page for a locked places.sqlite
    // This property is set earlier by places-database-locked topic.
    if (this._isPlacesDatabaseLocked) {
      this._showPlacesLockedNotificationBox();
    }

    // For any add-ons that were installed disabled and can be enabled offer
    // them to the user.
    let changedIDs = AddonManager.getStartupChanges(AddonManager.STARTUP_CHANGE_INSTALLED);
    if (changedIDs.length > 0) {
      let win = RecentWindow.getMostRecentBrowserWindow();
      AddonManager.getAddonsByIDs(changedIDs, function(aAddons) {
        aAddons.forEach(function(aAddon) {
          // If the add-on isn't user disabled or can't be enabled then skip it.
          if (!aAddon.userDisabled || !(aAddon.permissions & AddonManager.PERM_CAN_ENABLE))
            return;

          win.openUILinkIn("about:newaddon?id=" + aAddon.id, "tab");
        })
      });
    }

    let signingRequired = Services.prefs.getBoolPref("xpinstall.signatures.required");

    if (signingRequired) {
      let disabledAddons = AddonManager.getStartupChanges(AddonManager.STARTUP_CHANGE_DISABLED);
      AddonManager.getAddonsByIDs(disabledAddons, (addons) => {
        for (let addon of addons) {
          // WEs return null, skip.
          if (!addon) {
            continue;
          }
          
          if (addon.type == "experiment")
            continue;

          if (addon.signedState <= AddonManager.SIGNEDSTATE_MISSING) {
            this._notifyUnsignedAddonsDisabled();
            break;
          }
        }
      });
    }

    // Perform default browser checking.
    if (ShellService) {
#ifdef DEBUG
      let shouldCheck = false;
#else
      let shouldCheck = ShellService.shouldCheckDefaultBrowser;
#endif

      const skipDefaultBrowserCheck =
        Services.prefs.getBoolPref("browser.shell.skipDefaultBrowserCheckOnFirstRun") &&
        Services.prefs.getBoolPref("browser.shell.skipDefaultBrowserCheck");

      let promptCount = Services.prefs.getIntPref("browser.shell.defaultBrowserCheckCount");

      let willRecoverSession = false;
      try {
        let ss = Cc["@mozilla.org/browser/sessionstartup;1"].
                 getService(Ci.nsISessionStartup);
        willRecoverSession =
          (ss.sessionType == Ci.nsISessionStartup.RECOVER_SESSION);
      }
      catch (ex) { /* never mind; suppose SessionStore is broken */ }

      // startup check, check all assoc
      let isDefault = false;
      let isDefaultError = false;
      try {
        isDefault = ShellService.isDefaultBrowser(true, false);
      } catch (ex) {
        isDefaultError = true;
      }

      if (isDefault) {
        let now = (Math.floor(Date.now() / 1000)).toString();
        Services.prefs.setCharPref("browser.shell.mostRecentDateSetAsDefault", now);
      }

      let willPrompt = shouldCheck && !isDefault && !willRecoverSession;

      // Skip the "Set Default Browser" check during first-run or after the
      // browser has been run a few times.
      if (willPrompt) {
        if (skipDefaultBrowserCheck) {
          Services.prefs.setBoolPref("browser.shell.skipDefaultBrowserCheck", false);
          willPrompt = false;
        } else {
          promptCount++;
        }
        if (promptCount > 3) {
          willPrompt = false;
        }
      }

      if (willPrompt) {
        Services.prefs.setIntPref("browser.shell.defaultBrowserCheckCount", promptCount);
      }

      if (willPrompt) {
        Services.tm.mainThread.dispatch(function() {
          DefaultBrowserCheck.prompt(RecentWindow.getMostRecentBrowserWindow());
        }.bind(this), Ci.nsIThread.DISPATCH_NORMAL);
      }
    }
    // Shut down ghost window idle observer.
    if (this._isGhostBusterObserver) {
      this._ghostBusterService.removeIdleObserver(this, GHOSTBUSTER_INTERVAL);
      this._isGhostBusterObserver = false;
    }
    // Do one final unlink to combat shutdown issues.
    Cu.unlinkGhostWindows();
  },

  _onQuitRequest: function(aCancelQuit, aQuitType) {
    // If user has already dismissed quit request, then do nothing
    if ((aCancelQuit instanceof Ci.nsISupportsPRBool) && aCancelQuit.data)
      return;

    // There are several cases where we won't show a dialog here:
    // 1. There is only 1 tab open in 1 window
    // 2. The session will be restored at startup, indicated by
    //    browser.startup.page == 3 or browser.sessionstore.resume_session_once == true
    // 3. browser.warnOnQuit == false
    // 4. The browser is currently in Private Browsing mode
    // 5. The browser will be restarted.
    //
    // Otherwise these are the conditions and the associated dialogs that will be shown:
    // 1. aQuitType == "lastwindow" or "quit" and browser.showQuitWarning == true
    //    - The quit dialog will be shown
    // 2. aQuitType == "lastwindow" && browser.tabs.warnOnClose == true
    //    - The "closing multiple tabs" dialog will be shown
    //
    // aQuitType == "lastwindow" is overloaded. "lastwindow" is used to indicate
    // "the last window is closing but we're not quitting (a non-browser window is open)"
    // and also "we're quitting by closing the last window".

    if (aQuitType == "restart")
      return;

    var windowcount = 0;
    var pagecount = 0;
    var browserEnum = Services.wm.getEnumerator("navigator:browser");
    let allWindowsPrivate = true;
    while (browserEnum.hasMoreElements()) {
      // XXXbz should we skip closed windows here?
      windowcount++;

      var browser = browserEnum.getNext();
      if (!PrivateBrowsingUtils.isWindowPrivate(browser))
        allWindowsPrivate = false;
      var tabbrowser = browser.document.getElementById("content");
      if (tabbrowser)
        pagecount += tabbrowser.browsers.length - tabbrowser._numPinnedTabs;
    }

    this._saveSession = false;
    if (pagecount < 2)
      return;

    if (!aQuitType)
      aQuitType = "quit";

    // browser.warnOnQuit is a hidden global boolean to override all quit prompts
    // browser.showQuitWarning specifically covers quitting
    // browser.tabs.warnOnClose is the global "warn when closing multiple tabs" pref

    var sessionWillBeRestored = Services.prefs.getIntPref("browser.startup.page") == 3 ||
                                Services.prefs.getBoolPref("browser.sessionstore.resume_session_once");
    if (sessionWillBeRestored || !Services.prefs.getBoolPref("browser.warnOnQuit"))
      return;

    let win = Services.wm.getMostRecentWindow("navigator:browser");

    // On last window close or quit && showQuitWarning, we want to show the
    // quit warning.
    if (!Services.prefs.getBoolPref("browser.showQuitWarning")) {
      if (aQuitType == "lastwindow") {
        // If aQuitType is "lastwindow" and we aren't showing the quit warning,
        // we should show the window closing warning instead. warnAboutClosing
        // tabs checks browser.tabs.warnOnClose and returns if it's ok to close
        // the window. It doesn't actually close the window.
        aCancelQuit.data =
          !win.gBrowser.warnAboutClosingTabs(win.gBrowser.closingTabsEnum.ALL);
      }
      return;
    }

    let prompt = Services.prompt;
    let quitBundle = Services.strings.createBundle("chrome://browser/locale/quitDialog.properties");
    let appName = gBrandBundle.GetStringFromName("brandShortName");
    let quitDialogTitle = quitBundle.formatStringFromName("quitDialogTitle",
                                                          [appName], 1);
    let neverAskText = quitBundle.GetStringFromName("neverAsk2");
    let neverAsk = {value: false};

    let choice;
    if (allWindowsPrivate) {
      let text = quitBundle.formatStringFromName("messagePrivate", [appName], 1);
      let flags = prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_0 +
                  prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_1 +
                  prompt.BUTTON_POS_0_DEFAULT;
      choice = prompt.confirmEx(win, quitDialogTitle, text, flags,
                                quitBundle.GetStringFromName("quitTitle"),
                                quitBundle.GetStringFromName("cancelTitle"),
                                null,
                                neverAskText, neverAsk);

      // The order of the buttons differs between the prompt.confirmEx calls
      // here so we need to fix this for proper handling below.
      if (choice == 0) {
        choice = 2;
      }
    } else {
      let text = quitBundle.formatStringFromName(
        windowcount == 1 ? "messageNoWindows" : "message", [appName], 1);
      let flags = prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_0 +
                  prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_1 +
                  prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_2 +
                  prompt.BUTTON_POS_0_DEFAULT;
      choice = prompt.confirmEx(win, quitDialogTitle, text, flags,
                                quitBundle.GetStringFromName("saveTitle"),
                                quitBundle.GetStringFromName("cancelTitle"),
                                quitBundle.GetStringFromName("quitTitle"),
                                neverAskText, neverAsk);
    }

    switch (choice) {
    case 2: // Quit
      if (neverAsk.value)
        Services.prefs.setBoolPref("browser.showQuitWarning", false);
      break;
    case 1: // Cancel
      aCancelQuit.QueryInterface(Ci.nsISupportsPRBool);
      aCancelQuit.data = true;
      break;
    case 0: // Save & Quit
      this._saveSession = true;
      if (neverAsk.value) {
        // always save state when shutting down
        Services.prefs.setIntPref("browser.startup.page", 3);
      }
      break;
    }
  },

  _showUpdateNotification: function() {
    Services.prefs.clearUserPref("app.update.postupdate");

    var um = Cc["@mozilla.org/updates/update-manager;1"].
             getService(Ci.nsIUpdateManager);
    try {
      // If the updates.xml file is deleted then getUpdateAt will throw.
      var update = um.getUpdateAt(0).QueryInterface(Ci.nsIPropertyBag);
    }
    catch (e) {
      // This should never happen.
      Cu.reportError("Unable to find update: " + e);
      return;
    }

    var actions = update.getProperty("actions");
    if (!actions || actions.indexOf("silent") != -1)
      return;

    var formatter = Cc["@mozilla.org/toolkit/URLFormatterService;1"].
                    getService(Ci.nsIURLFormatter);
    var appName = gBrandBundle.GetStringFromName("brandShortName");

    function getNotifyString(aPropData) {
      var propValue = update.getProperty(aPropData.propName);
      if (!propValue) {
        if (aPropData.prefName)
          propValue = formatter.formatURLPref(aPropData.prefName);
        else if (aPropData.stringParams)
          propValue = gBrowserBundle.formatStringFromName(aPropData.stringName,
                                                          aPropData.stringParams,
                                                          aPropData.stringParams.length);
        else
          propValue = gBrowserBundle.GetStringFromName(aPropData.stringName);
      }
      return propValue;
    }

    if (actions.indexOf("showNotification") != -1) {
      let text = getNotifyString({propName: "notificationText",
                                  stringName: "puNotifyText",
                                  stringParams: [appName]});
      let url = getNotifyString({propName: "notificationURL",
                                 prefName: "startup.homepage_override_url"});
      let label = getNotifyString({propName: "notificationButtonLabel",
                                   stringName: "pu.notifyButton.label"});
      let key = getNotifyString({propName: "notificationButtonAccessKey",
                                 stringName: "pu.notifyButton.accesskey"});

      let win = RecentWindow.getMostRecentBrowserWindow();
      let notifyBox = win.document.getElementById("high-priority-global-notificationbox");

      let buttons = [
                      {
                        label:     label,
                        accessKey: key,
                        popup:     null,
                        callback: function(aNotificationBar, aButton) {
                          win.openUILinkIn(url, "tab");
                        }
                      }
                    ];

      notifyBox.appendNotification(text, "post-update-notification",
                                   null, notifyBox.PRIORITY_INFO_LOW,
                                   buttons);
    }

    if (actions.indexOf("showAlert") == -1)
      return;

    let title = getNotifyString({propName: "alertTitle",
                                 stringName: "puAlertTitle",
                                 stringParams: [appName]});
    let text = getNotifyString({propName: "alertText",
                                stringName: "puAlertText",
                                stringParams: [appName]});
    let url = getNotifyString({propName: "alertURL",
                               prefName: "startup.homepage_override_url"});

    function clickCallback(subject, topic, data) {
      // This callback will be called twice but only once with this topic
      if (topic != "alertclickcallback")
        return;
      let win = RecentWindow.getMostRecentBrowserWindow();
      win.openUILinkIn(data, "tab");
    }

    try {
      // This will throw NS_ERROR_NOT_AVAILABLE if the notification cannot
      // be displayed per the idl.
      AlertsService.showAlertNotification(null, title, text,
                                          true, url, clickCallback);
    }
    catch (e) {
      Cu.reportError(e);
    }
  },

  /**
   * Initialize Places
   * - imports the bookmarks html file if bookmarks database is empty, try to
   *   restore bookmarks from a JSON backup if the backend indicates that the
   *   database was corrupt.
   *
   * These prefs can be set up by the frontend:
   *
   * WARNING: setting these preferences to true will overwite existing bookmarks
   *
   * - browser.places.importBookmarksHTML
   *   Set to true will import the bookmarks.html file from the profile folder.
   * - browser.places.smartBookmarksVersion
   *   Set during HTML import to indicate that Smart Bookmarks were created.
   *   Set to -1 to disable Smart Bookmarks creation.
   *   Set to 0 to restore current Smart Bookmarks.
   * - browser.bookmarks.restore_default_bookmarks
   *   Set to true by safe-mode dialog to indicate we must restore default
   *   bookmarks.
   */
  _initPlaces: function(aInitialMigrationPerformed) {
    // We must instantiate the history service since it will tell us if we
    // need to import or restore bookmarks due to first-run, corruption or
    // forced migration (due to a major schema change).
    // If the database is corrupt or has been newly created we should
    // import bookmarks.
    let dbStatus = PlacesUtils.history.databaseStatus;
    let importBookmarks = !aInitialMigrationPerformed &&
                          (dbStatus == PlacesUtils.history.DATABASE_STATUS_CREATE ||
                           dbStatus == PlacesUtils.history.DATABASE_STATUS_CORRUPT);

    // Check if user or an extension has required to import bookmarks.html
    let importBookmarksHTML = false;
    try {
      importBookmarksHTML =
        Services.prefs.getBoolPref("browser.places.importBookmarksHTML");
      if (importBookmarksHTML)
        importBookmarks = true;
    } catch (ex) {}

    // Support legacy bookmarks.html format for apps that depend on that format.
    let autoExportHTML = Services.prefs.getBoolPref("browser.bookmarks.autoExportHTML", false);  // Do not export.
    if (autoExportHTML) {
      // Sqlite.jsm and Places shutdown happen at profile-before-change, thus,
      // to be on the safe side, this should run earlier.
      AsyncShutdown.profileChangeTeardown.addBlocker(
        "Places: export bookmarks.html",
        () => BookmarkHTMLUtils.exportToFile(BookmarkHTMLUtils.defaultPath));
    }

    Task.spawn(function* () {
      // Check if Safe Mode or the user has required to restore bookmarks from
      // default profile's bookmarks.html
      let restoreDefaultBookmarks = false;
      try {
        restoreDefaultBookmarks =
          Services.prefs.getBoolPref("browser.bookmarks.restore_default_bookmarks");
        if (restoreDefaultBookmarks) {
          // Ensure that we already have a bookmarks backup for today.
          yield this._backupBookmarks();
          importBookmarks = true;
        }
      } catch (ex) {}

      // This may be reused later, check for "=== undefined" to see if it has
      // been populated already.
      let lastBackupFile;

      // If the user did not require to restore default bookmarks, or import
      // from bookmarks.html, we will try to restore from JSON
      if (importBookmarks && !restoreDefaultBookmarks && !importBookmarksHTML) {
        // get latest JSON backup
        lastBackupFile = yield PlacesBackups.getMostRecentBackup();
        if (lastBackupFile) {
          // restore from JSON backup
          yield BookmarkJSONUtils.importFromFile(lastBackupFile, true);
          importBookmarks = false;
        }
        else {
          // We have created a new database but we don't have any backup available
          importBookmarks = true;
          if (yield OS.File.exists(BookmarkHTMLUtils.defaultPath)) {
            // If bookmarks.html is available in current profile import it...
            importBookmarksHTML = true;
          }
          else {
            // ...otherwise we will restore defaults
            restoreDefaultBookmarks = true;
          }
        }
      }

      // If bookmarks are not imported, then initialize smart bookmarks.  This
      // happens during a common startup.
      // Otherwise, if any kind of import runs, smart bookmarks creation should be
      // delayed till the import operations has finished.  Not doing so would
      // cause them to be overwritten by the newly imported bookmarks.
      if (!importBookmarks) {
        // Now apply distribution customized bookmarks.
        // This should always run after Places initialization.
        try {
          yield this._distributionCustomizer.applyBookmarks();
          yield this.ensurePlacesDefaultQueriesInitialized();
        } catch (e) {
          Cu.reportError(e);
        }
      }
      else {
        // An import operation is about to run.
        // Don't try to recreate smart bookmarks if autoExportHTML is true or
        // smart bookmarks are disabled.
        let smartBookmarksVersion = Services.prefs.getIntPref("browser.places.smartBookmarksVersion", 0);
        if (!autoExportHTML && smartBookmarksVersion != -1)
          Services.prefs.setIntPref("browser.places.smartBookmarksVersion", 0);

        let bookmarksUrl = null;
        if (restoreDefaultBookmarks) {
          // User wants to restore bookmarks.html file from default profile folder
          bookmarksUrl = "chrome://browser/locale/bookmarks.html";
        }
        else if (yield OS.File.exists(BookmarkHTMLUtils.defaultPath)) {
          bookmarksUrl = OS.Path.toFileURI(BookmarkHTMLUtils.defaultPath);
        }

        if (bookmarksUrl) {
          // Import from bookmarks.html file.
          try {
            yield BookmarkHTMLUtils.importFromURL(bookmarksUrl, true);
          } catch (e) {
            Cu.reportError("Bookmarks.html file could be corrupt. " + e);
          }
          try {
            // Now apply distribution customized bookmarks.
            // This should always run after Places initialization.
            yield this._distributionCustomizer.applyBookmarks();
            // Ensure that smart bookmarks are created once the operation is
            // complete.
            yield this.ensurePlacesDefaultQueriesInitialized();
          } catch (e) {
            Cu.reportError(e);
          }

        }
        else {
          Cu.reportError(new Error("Unable to find bookmarks.html file."));
        }

        // Reset preferences, so we won't try to import again at next run
        if (importBookmarksHTML)
          Services.prefs.setBoolPref("browser.places.importBookmarksHTML", false);
        if (restoreDefaultBookmarks)
          Services.prefs.setBoolPref("browser.bookmarks.restore_default_bookmarks",
                                     false);
      }

      // Initialize bookmark archiving on idle.
      if (!this._bookmarksBackupIdleTime) {
        this._bookmarksBackupIdleTime = BOOKMARKS_BACKUP_IDLE_TIME_SEC;

        // If there is no backup, or the last bookmarks backup is too old, use
        // a more aggressive idle observer.
        if (lastBackupFile === undefined)
          lastBackupFile = yield PlacesBackups.getMostRecentBackup();
        if (!lastBackupFile) {
            this._bookmarksBackupIdleTime /= 2;
        }
        else {
          let lastBackupTime = PlacesBackups.getDateForFile(lastBackupFile);
          let profileLastUse = Services.appinfo.replacedLockTime || Date.now();

          // If there is a backup after the last profile usage date it's fine,
          // regardless its age.  Otherwise check how old is the last
          // available backup compared to that session.
          if (profileLastUse > lastBackupTime) {
            let backupAge = Math.round((profileLastUse - lastBackupTime) / 86400000);

            if (backupAge > BOOKMARKS_BACKUP_MAX_INTERVAL_DAYS)
              this._bookmarksBackupIdleTime /= 2;
          }
        }
        this._idleService.addIdleObserver(this, this._bookmarksBackupIdleTime);
      }

    }.bind(this)).catch(ex => {
      Cu.reportError(ex);
    }).then(() => {
      // NB: deliberately after the catch so that we always do this, even if
      // we threw halfway through initializing in the Task above.
      Services.obs.notifyObservers(null, "places-browser-init-complete", "");
    });
  },

  /**
   * If a backup for today doesn't exist, this creates one.
   */
  _backupBookmarks: function() {
    return Task.spawn(function*() {
      let lastBackupFile = yield PlacesBackups.getMostRecentBackup();
      // Should backup bookmarks if there are no backups or the maximum
      // interval between backups elapsed.
      if (!lastBackupFile ||
          new Date() - PlacesBackups.getDateForFile(lastBackupFile) > BOOKMARKS_BACKUP_MIN_INTERVAL_DAYS * 86400000) {
        let maxBackups = Services.prefs.getIntPref("browser.bookmarks.max_backups");
        yield PlacesBackups.create(maxBackups);
      }
    });
  },

  /**
   * Show the notificationBox for a locked places database.
   */
  _showPlacesLockedNotificationBox: function() {
    var applicationName = gBrandBundle.GetStringFromName("brandShortName");
    var placesBundle = Services.strings.createBundle("chrome://browser/locale/places/places.properties");
    var title = placesBundle.GetStringFromName("lockPrompt.title");
    var text = placesBundle.formatStringFromName("lockPrompt.text", [applicationName], 1);
    var buttonText = placesBundle.GetStringFromName("lockPromptInfoButton.label");
    var accessKey = placesBundle.GetStringFromName("lockPromptInfoButton.accessKey");

    var helpTopic = "places-locked";
    var url = Cc["@mozilla.org/toolkit/URLFormatterService;1"].
              getService(Components.interfaces.nsIURLFormatter).
              formatURLPref("app.support.baseURL");
    url += helpTopic;

    var win = RecentWindow.getMostRecentBrowserWindow();

    var buttons = [
                    {
                      label:     buttonText,
                      accessKey: accessKey,
                      popup:     null,
                      callback:  function(aNotificationBar, aButton) {
                        win.openUILinkIn(url, "tab");
                      }
                    }
                  ];

    var notifyBox = win.gBrowser.getNotificationBox();
    var notification = notifyBox.appendNotification(text, title, null,
                                                    notifyBox.PRIORITY_CRITICAL_MEDIUM,
                                                    buttons);
    notification.persistence = -1; // Until user closes it
  },

  _showSyncStartedDoorhanger: function () {
    let bundle = Services.strings.createBundle("chrome://browser/locale/accounts.properties");
    let productName = gBrandBundle.GetStringFromName("brandShortName");
    let title = bundle.GetStringFromName("syncStartNotification.title");
    let body = bundle.formatStringFromName("syncStartNotification.body2",
                                            [productName], 1);

    let clickCallback = (subject, topic, data) => {
      if (topic != "alertclickcallback")
        return;
      this._openPreferences("sync");
    }
    AlertsService.showAlertNotification(null, title, body, true, null, clickCallback);
  },

  _migrateUI: function() {
    const UI_VERSION = 45;
    const BROWSER_DOCURL = "chrome://browser/content/browser.xul";

    let currentUIVersion;
    if (Services.prefs.prefHasUserValue("browser.migration.version")) {
      currentUIVersion = Services.prefs.getIntPref("browser.migration.version");
    } else {
      // This is a new profile, nothing to migrate.
      Services.prefs.setIntPref("browser.migration.version", UI_VERSION);
      return;
    }

    if (currentUIVersion >= UI_VERSION)
      return;

    let xulStore = Cc["@mozilla.org/xul/xulstore;1"].getService(Ci.nsIXULStore);

    if (currentUIVersion < 9) {
      // This code adds the customizable downloads buttons.
      let currentset = xulStore.getValue(BROWSER_DOCURL, "nav-bar", "currentset");

      // Since the Downloads button is located in the navigation bar by default,
      // migration needs to happen only if the toolbar was customized using a
      // previous UI version, and the button was not already placed on the
      // toolbar manually.
      if (currentset &&
          currentset.indexOf("downloads-button") == -1) {
        // The element is added either after the search bar or before the home
        // button. As a last resort, the element is added just before the
        // non-customizable window controls.
        if (currentset.indexOf("search-container") != -1) {
          currentset = currentset.replace(/(^|,)search-container($|,)/,
                                          "$1search-container,downloads-button$2")
        } else if (currentset.indexOf("home-button") != -1) {
          currentset = currentset.replace(/(^|,)home-button($|,)/,
                                          "$1downloads-button,home-button$2")
        } else {
          currentset = currentset.replace(/(^|,)window-controls($|,)/,
                                          "$1downloads-button,window-controls$2")
        }
        xulStore.setValue(BROWSER_DOCURL, "nav-bar", "currentset", currentset);
      }
    }

#ifdef XP_WIN
    if (currentUIVersion < 10) {
      // For Windows systems with display set to > 96dpi (i.e. systemDefaultScale
      // will return a value > 1.0), we want to discard any saved full-zoom settings,
      // as we'll now be scaling the content according to the system resolution
      // scale factor (Windows "logical DPI" setting)
      let sm = Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager);
      if (sm.systemDefaultScale > 1.0) {
        let cps2 = Cc["@mozilla.org/content-pref/service;1"].
                    getService(Ci.nsIContentPrefService2);
        cps2.removeByName("browser.content.full-zoom", null);
      }
    }
#endif

    if (currentUIVersion < 11) {
      Services.prefs.clearUserPref("dom.disable_window_move_resize");
      Services.prefs.clearUserPref("dom.disable_window_flip");
      Services.prefs.clearUserPref("dom.event.contextmenu.enabled");
      Services.prefs.clearUserPref("javascript.enabled");
      Services.prefs.clearUserPref("permissions.default.image");
    }

    if (currentUIVersion < 14) {
      // DOM Storage doesn't specially handle about: pages anymore.
      let path = OS.Path.join(OS.Constants.Path.profileDir,
                              "chromeappsstore.sqlite");
      OS.File.remove(path);
    }

    if (currentUIVersion < 16) {
      xulStore.removeValue(BROWSER_DOCURL, "nav-bar", "collapsed");
    }

    // Insert the bookmarks-menu-button into the nav-bar if it isn't already
    // there.
    if (currentUIVersion < 17) {
      let currentset = xulStore.getValue(BROWSER_DOCURL, "nav-bar", "currentset");
      // Need to migrate only if toolbar is customized.
      if (currentset) {
        if (!currentset.includes("bookmarks-menu-button")) {
          // The button isn't in the nav-bar, so let's look for an appropriate
          // place to put it.
          if (currentset.includes("bookmarks-menu-button-container")) {
            currentset = currentset.replace(/(^|,)bookmarks-menu-button-container($|,)/,
                                            "$1bookmarks-menu-button$2");
          } else if (currentset.includes("downloads-button")) {
            currentset = currentset.replace(/(^|,)downloads-button($|,)/,
                                            "$1bookmarks-menu-button,downloads-button$2");
          } else if (currentset.includes("home-button")) {
            currentset = currentset.replace(/(^|,)home-button($|,)/,
                                            "$1bookmarks-menu-button,home-button$2");
          } else {
            // Just append.
            currentset = currentset.replace(/(^|,)window-controls($|,)/,
                                            "$1bookmarks-menu-button,window-controls$2")
          }
          xulStore.setValue(BROWSER_DOCURL, "nav-bar", "currentset", currentset);
        }
      }
    }

    if (currentUIVersion < 18) {
      // Remove iconsize and mode from all the toolbars
      let toolbars = ["navigator-toolbox", "nav-bar", "PersonalToolbar",
                      "addon-bar", "TabsToolbar", "toolbar-menubar"];
      for (let resourceName of ["mode", "iconsize"]) {
        for (let toolbarId of toolbars) {
          xulStore.removeValue(BROWSER_DOCURL, toolbarId, resourceName);
        }
      }
    }

    if (currentUIVersion < 19) {
      let detector = null;
      try {
        detector = Services.prefs.getComplexValue("intl.charset.detector",
                                                  Ci.nsIPrefLocalizedString).data;
      } catch (ex) {}
      if (!(detector == "" ||
            detector == "ja_parallel_state_machine" ||
            detector == "ruprob" ||
            detector == "ukprob")) {
        // If the encoding detector pref value is not reachable from the UI,
        // reset to default (varies by localization).
        Services.prefs.clearUserPref("intl.charset.detector");
      }
    }

    if (currentUIVersion < 20) {
      // Remove persisted collapsed state from TabsToolbar.
      xulStore.removeValue(BROWSER_DOCURL, "TabsToolbar", "collapsed");
    }

    if (currentUIVersion < 23) {
      const kSelectedEnginePref = "browser.search.selectedEngine";
      if (Services.prefs.prefHasUserValue(kSelectedEnginePref)) {
        try {
          let name = Services.prefs.getComplexValue(kSelectedEnginePref,
                                                    Ci.nsIPrefLocalizedString).data;
          Services.search.currentEngine = Services.search.getEngineByName(name);
        } catch (ex) {}
      }
    }

    if (currentUIVersion < 24) {
      // Reset homepage pref for users who have it set to start.mozilla.org
      // or google.com/firefox.
      const HOMEPAGE_PREF = "browser.startup.homepage";
      if (Services.prefs.prefHasUserValue(HOMEPAGE_PREF)) {
        const DEFAULT =
          Services.prefs.getDefaultBranch(HOMEPAGE_PREF)
                        .getComplexValue("", Ci.nsIPrefLocalizedString).data;
        let value =
          Services.prefs.getComplexValue(HOMEPAGE_PREF, Ci.nsISupportsString);
        let updated =
          value.data.replace(/https?:\/\/start\.mozilla\.org[^|]*/i, DEFAULT)
                    .replace(/https?:\/\/(www\.)?google\.[a-z.]+\/firefox[^|]*/i,
                             DEFAULT);
        if (updated != value.data) {
          if (updated == DEFAULT) {
            Services.prefs.clearUserPref(HOMEPAGE_PREF);
          } else {
            value.data = updated;
            Services.prefs.setComplexValue(HOMEPAGE_PREF,
                                           Ci.nsISupportsString, value);
          }
        }
      }
    }

    if (currentUIVersion < 25) {
      // Make sure the doNotTrack value conforms to the conversion from
      // three-state to two-state. (This reverts a setting of "please track me"
      // to the default "don't say anything").
      try {
        if (Services.prefs.getBoolPref("privacy.donottrackheader.enabled") &&
            Services.prefs.getIntPref("privacy.donottrackheader.value") != 1) {
          Services.prefs.clearUserPref("privacy.donottrackheader.enabled");
          Services.prefs.clearUserPref("privacy.donottrackheader.value");
        }
      }
      catch (ex) {}
    }

    if (currentUIVersion < 26) {
      // Refactor urlbar suggestion preferences to make it extendable and
      // allow new suggestion types (e.g: search suggestions).
      let types = ["history", "bookmark", "openpage"];
      let defaultBehavior = Services.prefs.getIntPref("browser.urlbar.default.behavior", 0);
      try {
        let autocompleteEnabled = Services.prefs.getBoolPref("browser.urlbar.autocomplete.enabled");
        if (!autocompleteEnabled) {
          defaultBehavior = -1;
        }
      } catch (ex) {}

      // If the default behavior is:
      //    -1  - all new "...suggest.*" preferences will be false
      //     0  - all new "...suggest.*" preferences will use the default values
      //   > 0  - all new "...suggest.*" preferences will be inherited
      for (let type of types) {
        let prefValue = defaultBehavior == 0;
        if (defaultBehavior > 0) {
          prefValue = !!(defaultBehavior & Ci.mozIPlacesAutoComplete["BEHAVIOR_" + type.toUpperCase()]);
        }
        Services.prefs.setBoolPref("browser.urlbar.suggest." + type, prefValue);
      }

      // Typed behavior will be used only for results from history.
      if (defaultBehavior != -1 &&
          !!(defaultBehavior & Ci.mozIPlacesAutoComplete["BEHAVIOR_TYPED"])) {
        Services.prefs.setBoolPref("browser.urlbar.suggest.history.onlyTyped", true);
      }
    }

    if (currentUIVersion < 27) {
      // Fix up document color use:
      const kOldColorPref = "browser.display.use_document_colors";
      if (Services.prefs.prefHasUserValue(kOldColorPref) &&
          !Services.prefs.getBoolPref(kOldColorPref)) {
        Services.prefs.setIntPref("browser.display.document_color_use", 2);
      }
    }

    if (currentUIVersion < 29) {
      let group = null;
      try {
        group = Services.prefs.getComplexValue("font.language.group",
                                               Ci.nsIPrefLocalizedString);
      } catch (ex) {}
      if (group &&
          ["tr", "x-baltic", "x-central-euro"].some(g => g == group.data)) {
        // Latin groups were consolidated.
        group.data = "x-western";
        Services.prefs.setComplexValue("font.language.group",
                                       Ci.nsIPrefLocalizedString, group);
      }
    }

    if (currentUIVersion < 30) {
      // Convert old devedition theme pref to lightweight theme storage
      let lightweightThemeSelected = Services.prefs.prefHasUserValue("lightweightThemes.selectedThemeID", false);
      let selectedThemeID = Services.prefs.getCharPref("lightweightThemes.selectedThemeID", "");

      let defaultThemeSelected = false;
      try {
         defaultThemeSelected = Services.prefs.getCharPref("general.skins.selectedSkin") == "classic/1.0";
      } catch (e) {}

      // If we have the dev edition theme selected, reset it.
      if (selectedThemeID == "firefox-devedition@mozilla.org") {
        Services.prefs.setCharPref("lightweightThemes.selectedThemeID", "");
      }

      Services.prefs.clearUserPref("browser.devedition.showCustomizeButton");
    }

    if (currentUIVersion < 31) {
      xulStore.removeValue(BROWSER_DOCURL, "bookmarks-menu-button", "class");
      xulStore.removeValue(BROWSER_DOCURL, "home-button", "class");
    }

    if (currentUIVersion < 32) {
      this._notifyNotificationsUpgrade().catch(Cu.reportError);
    }

    // version 35 migrated tab groups data.

    if (currentUIVersion < 36) {
      xulStore.removeValue("chrome://passwordmgr/content/passwordManager.xul",
                           "passwordCol",
                           "hidden");
    }

    if (currentUIVersion < 37) {
      Services.prefs.clearUserPref("browser.sessionstore.restore_on_demand");
    }

    if (currentUIVersion < 38) {
      LoginHelper.removeLegacySignonFiles();
    }

    if (currentUIVersion < 39) {
      // Remove the 'defaultset' value for all the toolbars
      let toolbars = ["nav-bar", "PersonalToolbar",
                      "addon-bar", "TabsToolbar", "toolbar-menubar"];
      for (let toolbarId of toolbars) {
        xulStore.removeValue(BROWSER_DOCURL, toolbarId, "defaultset");
      }
    }

    if (currentUIVersion < 40) {
      const kOldSafeBrowsingPref = "browser.safebrowsing.enabled";
      // Default value is set to true, a user pref means that the pref was
      // set to false.
      if (Services.prefs.prefHasUserValue(kOldSafeBrowsingPref) &&
          !Services.prefs.getBoolPref(kOldSafeBrowsingPref)) {
        Services.prefs.setBoolPref("browser.safebrowsing.phishing.enabled",
                                   false);
        // Should just remove support for the pref entirely, even if it's
        // only in about:config
        Services.prefs.clearUserPref(kOldSafeBrowsingPref);
      }
    }

    if (currentUIVersion < 41) {
      const Preferences = Cu.import("resource://gre/modules/Preferences.jsm", {}).Preferences;
      Preferences.resetBranch("loop.");
    }

    if (currentUIVersion < 42) {
      let backupFile = Services.dirsvc.get("ProfD", Ci.nsIFile);
      backupFile.append("tabgroups-session-backup.json");
      OS.File.remove(backupFile.path, {ignoreAbsent: true}).catch(ex => Cu.reportError(ex));
    }

    if (currentUIVersion < 43) {
      if (Services.prefs.prefHasUserValue("layers.acceleration.disabled")) {
        let HWADisabled = Services.prefs.getBoolPref("layers.acceleration.disabled");
        Services.prefs.setBoolPref("layers.acceleration.enabled", !HWADisabled);
        Services.prefs.setBoolPref("gfx.direct2d.disabled", HWADisabled);
      }
      if (Services.prefs.getBoolPref("layers.acceleration.force-enabled", false)) {
        Services.prefs.setBoolPref("layers.acceleration.force", true);
      }
      Services.prefs.clearUserPref("layers.acceleration.disabled");
      Services.prefs.clearUserPref("layers.acceleration.force-enabled");
    }

    if (currentUIVersion < 44) {
      // DoNotTrack is now GPC. Carry across user preference.
      if (Services.prefs.prefHasUserValue("privacy.donottrackheader.enabled")) {
        let DNTEnabled = Services.prefs.getBoolPref("privacy.donottrackheader.enabled");
        Services.prefs.setBoolPref("privacy.GPCheader.enabled", DNTEnabled);
        Services.prefs.clearUserPref("privacy.donottrackheader.enabled");
      }
    }

    if (currentUIVersion < 45) {
      // Clear hardware decoding failure flag to re-test. (UXP #1898)
      Services.prefs.clearUserPref("media.hardware-video-decoding.failed");
    }

    // Update the migration version.
    Services.prefs.setIntPref("browser.migration.version", UI_VERSION);
  },

  _hasExistingNotificationPermission: function() {
    let enumerator = Services.perms.enumerator;
    while (enumerator.hasMoreElements()) {
      let permission = enumerator.getNext().QueryInterface(Ci.nsIPermission);
      if (permission.type == "desktop-notification") {
        return true;
      }
    }
    return false;
  },

  _notifyNotificationsUpgrade: Task.async(function* () {
    if (!this._hasExistingNotificationPermission()) {
      return;
    }
    yield this._firstWindowReady;
    function clickCallback(subject, topic, data) {
      if (topic != "alertclickcallback")
        return;
      let win = RecentWindow.getMostRecentBrowserWindow();
      win.openUILinkIn(data, "tab");
    }
    // Show the application icon for XUL notifications. We assume system-level
    // notifications will include their own icon.
    let imageURL = this._hasSystemAlertsService() ? "" :
                   "chrome://branding/content/about-logo.png";
    let title = gBrowserBundle.GetStringFromName("webNotifications.upgradeTitle");
    let text = gBrowserBundle.GetStringFromName("webNotifications.upgradeBody");
    let url = Services.urlFormatter.formatURLPref("app.support.baseURL") +
      "push#w_upgraded-notifications";

    AlertsService.showAlertNotification(imageURL, title, text,
                                        true, url, clickCallback);
  }),

  _hasSystemAlertsService: function() {
    try {
      return !!Cc["@mozilla.org/system-alerts-service;1"].getService(
        Ci.nsIAlertsService);
    } catch (e) {}
    return false;
  },

  // ------------------------------
  // public nsIBrowserGlue members
  // ------------------------------

  sanitize: function(aParentWindow) {
    this._sanitizer.sanitize(aParentWindow);
  },

  ensurePlacesDefaultQueriesInitialized: Task.async(function* () {
    // This is the current smart bookmarks version, it must be increased every
    // time they change.
    // When adding a new smart bookmark below, its newInVersion property must
    // be set to the version it has been added in.  We will compare its value
    // to users' smartBookmarksVersion and add new smart bookmarks without
    // recreating old deleted ones.
    const SMART_BOOKMARKS_VERSION = 8;
    const SMART_BOOKMARKS_ANNO = "Places/SmartBookmark";
    const SMART_BOOKMARKS_PREF = "browser.places.smartBookmarksVersion";

    // TODO bug 399268: should this be a pref?
    const MAX_RESULTS = 10;

    // Get current smart bookmarks version.  If not set, create them.
    let smartBookmarksCurrentVersion = Services.prefs.getIntPref(SMART_BOOKMARKS_PREF, 0);

    // If version is current, or smart bookmarks are disabled, bail out.
    if (smartBookmarksCurrentVersion == -1 ||
        smartBookmarksCurrentVersion >= SMART_BOOKMARKS_VERSION) {
      return;
    }

    try {
      let menuIndex = 0;
      let toolbarIndex = 0;
      let bundle = Services.strings.createBundle("chrome://browser/locale/places/places.properties");
      let queryOptions = Ci.nsINavHistoryQueryOptions;

      let smartBookmarks = {
        MostVisited: {
          title: bundle.GetStringFromName("mostVisitedTitle"),
          url: "place:sort=" + queryOptions.SORT_BY_VISITCOUNT_DESCENDING +
                    "&maxResults=" + MAX_RESULTS,
          parentGuid: PlacesUtils.bookmarks.toolbarGuid,
          newInVersion: 1
        },
        RecentTags: {
          title: bundle.GetStringFromName("recentTagsTitle"),
          url: "place:type=" + queryOptions.RESULTS_AS_TAG_QUERY +
                    "&sort=" + queryOptions.SORT_BY_LASTMODIFIED_DESCENDING +
                    "&maxResults=" + MAX_RESULTS,
          parentGuid: PlacesUtils.bookmarks.menuGuid,
          newInVersion: 1
        },
      };

      // Set current guid, parentGuid and index of existing Smart Bookmarks.
      // We will use those to create a new version of the bookmark at the same
      // position.
      let smartBookmarkItemIds = PlacesUtils.annotations.getItemsWithAnnotation(SMART_BOOKMARKS_ANNO);
      for (let itemId of smartBookmarkItemIds) {
        let queryId = PlacesUtils.annotations.getItemAnnotation(itemId, SMART_BOOKMARKS_ANNO);
        if (queryId in smartBookmarks) {
          // Known smart bookmark.
          let smartBookmark = smartBookmarks[queryId];
          smartBookmark.guid = yield PlacesUtils.promiseItemGuid(itemId);

          if (!smartBookmark.url) {
            yield PlacesUtils.bookmarks.remove(smartBookmark.guid);
            continue;
          }

          let bm = yield PlacesUtils.bookmarks.fetch(smartBookmark.guid);
          smartBookmark.parentGuid = bm.parentGuid;
          smartBookmark.index = bm.index;
        }
        else {
          // We don't remove old Smart Bookmarks because user could still
          // find them useful, or could have personalized them.
          // Instead we remove the Smart Bookmark annotation.
          PlacesUtils.annotations.removeItemAnnotation(itemId, SMART_BOOKMARKS_ANNO);
        }
      }

      for (let queryId of Object.keys(smartBookmarks)) {
        let smartBookmark = smartBookmarks[queryId];

        // We update or create only changed or new smart bookmarks.
        // Also we respect user choices, so we won't try to create a smart
        // bookmark if it has been removed.
        if (smartBookmarksCurrentVersion > 0 &&
            smartBookmark.newInVersion <= smartBookmarksCurrentVersion &&
            !smartBookmark.guid || !smartBookmark.url)
          continue;

        // Remove old version of the smart bookmark if it exists, since it
        // will be replaced in place.
        if (smartBookmark.guid) {
          yield PlacesUtils.bookmarks.remove(smartBookmark.guid);
        }

        // Create the new smart bookmark and store its updated guid.
        if (!("index" in smartBookmark)) {
          if (smartBookmark.parentGuid == PlacesUtils.bookmarks.toolbarGuid)
            smartBookmark.index = toolbarIndex++;
          else if (smartBookmark.parentGuid == PlacesUtils.bookmarks.menuGuid)
            smartBookmark.index = menuIndex++;
        }
        smartBookmark = yield PlacesUtils.bookmarks.insert(smartBookmark);
        let itemId = yield PlacesUtils.promiseItemId(smartBookmark.guid);
        PlacesUtils.annotations.setItemAnnotation(itemId,
                                                  SMART_BOOKMARKS_ANNO,
                                                  queryId, 0,
                                                  PlacesUtils.annotations.EXPIRE_NEVER);
      }

      // If we are creating all Smart Bookmarks from ground up, add a
      // separator below them in the bookmarks menu.
      if (smartBookmarksCurrentVersion == 0 &&
          smartBookmarkItemIds.length == 0) {
        let bm = yield PlacesUtils.bookmarks.fetch({ parentGuid: PlacesUtils.bookmarks.menuGuid,
                                                     index: menuIndex });
        // Don't add a separator if the menu was empty or there is one already.
        if (bm && bm.type != PlacesUtils.bookmarks.TYPE_SEPARATOR) {
          yield PlacesUtils.bookmarks.insert({ type: PlacesUtils.bookmarks.TYPE_SEPARATOR,
                                               parentGuid: PlacesUtils.bookmarks.menuGuid,
                                               index: menuIndex });
        }
      }
    } catch (ex) {
      Cu.reportError(ex);
    } finally {
      Services.prefs.setIntPref(SMART_BOOKMARKS_PREF, SMART_BOOKMARKS_VERSION);
      Services.prefs.savePrefFile(null);
    }
  }),

  /**
   * Open preferences even if there are no open windows.
   */
  _openPreferences(...args) {
    if (Services.appShell.hiddenDOMWindow.openPreferences) {
      Services.appShell.hiddenDOMWindow.openPreferences(...args);
      return;
    }

    let chromeWindow = RecentWindow.getMostRecentBrowserWindow();
    chromeWindow.openPreferences(...args);
  },

#ifdef MOZ_SERVICES_SYNC
  /**
   * Called as an observer when Sync's "display URI" notification is fired.
   *
   * We open the received URI in a background tab.
   *
   * Eventually, this will likely be replaced by a more robust tab syncing
   * feature. This functionality is considered somewhat evil by UX because it
   * opens a new tab automatically without any prompting. However, it is a
   * lesser evil than sending a tab to a specific device (from e.g. Fennec)
   * and having nothing happen on the receiving end.
   */
  _onDisplaySyncURI: function(data) {
    try {
      let tabbrowser = RecentWindow.getMostRecentBrowserWindow({private: false}).gBrowser;

      // The payload is wrapped weirdly because of how Sync does notifications.
      tabbrowser.addTab(data.wrappedJSObject.object.uri);
    } catch (ex) {
      Cu.reportError("Error displaying tab received by Sync: " + ex);
    }
  },
#endif

  _onDeviceDisconnected() {
    let bundle = Services.strings.createBundle("chrome://browser/locale/accounts.properties");
    let title = bundle.GetStringFromName("deviceDisconnectedNotification.title");
    let body = bundle.GetStringFromName("deviceDisconnectedNotification.body");

    let clickCallback = (subject, topic, data) => {
      if (topic != "alertclickcallback")
        return;
      this._openPreferences("sync");
    }
    AlertsService.showAlertNotification(null, title, body, true, null, clickCallback);
  },

  _handleFlashHang: function() {
    ++this._flashHangCount;
    if (this._flashHangCount < 2) {
      return;
    }
    // protected mode only applies to win32
    if (Services.appinfo.XPCOMABI != "x86-msvc") {
      return;
    }

    if (Services.prefs.getBoolPref("dom.ipc.plugins.flash.disable-protected-mode")) {
      return;
    }
    if (!Services.prefs.getBoolPref("browser.flash-protected-mode-flip.enable")) {
      return;
    }
    if (Services.prefs.getBoolPref("browser.flash-protected-mode-flip.done")) {
      return;
    }
    Services.prefs.setBoolPref("dom.ipc.plugins.flash.disable-protected-mode", true);
    Services.prefs.setBoolPref("browser.flash-protected-mode-flip.done", true);

    let win = RecentWindow.getMostRecentBrowserWindow();
    if (!win) {
      return;
    }
    let productName = gBrandBundle.GetStringFromName("brandShortName");
    let message = win.gNavigatorBundle.
      getFormattedString("flashHang.message", [productName]);
    let buttons = [{
      label: win.gNavigatorBundle.getString("flashHang.helpButton.label"),
      accessKey: win.gNavigatorBundle.getString("flashHang.helpButton.accesskey"),
      callback: function() {
        win.openUILinkIn("https://support.mozilla.org/kb/flash-protected-mode-autodisabled", "tab");
      }
    }];
    let nb = win.document.getElementById("global-notificationbox");
    nb.appendNotification(message, "flash-hang", null,
                          nb.PRIORITY_INFO_MEDIUM, buttons);
  },

  // for XPCOM
  classID:          Components.ID("{eab9012e-5f74-4cbc-b2b5-a590235513cc}"),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                         Ci.nsISupportsWeakReference,
                                         Ci.nsIBrowserGlue]),

  // redefine the default factory for XPCOMUtils
  _xpcom_factory: BrowserGlueServiceFactory,
}

/**
 * ContentPermissionIntegration is responsible for showing the user
 * simple permission prompts when content requests additional
 * capabilities.
 *
 * While there are some built-in permission prompts, createPermissionPrompt
 * can also be overridden by system add-ons or tests to provide new ones.
 *
 * This override ability is provided by Integration.jsm. See
 * PermissionUI.jsm for an example of how to provide a new prompt
 * from an add-on.
 */
const ContentPermissionIntegration = {
  /**
   * Creates a PermissionPrompt for a given permission type and
   * nsIContentPermissionRequest.
   *
   * @param {string} type
   *        The type of the permission request from content. This normally
   *        matches the "type" field of an nsIContentPermissionType, but it
   *        can be something else if the permission does not use the
   *        nsIContentPermissionRequest model. Note that this type might also
   *        be different from the permission key used in the permissions
   *        database.
   *        Example: "geolocation"
   * @param {nsIContentPermissionRequest} request
   *        The request for a permission from content.
   * @return {PermissionPrompt} (see PermissionUI.jsm),
   *         or undefined if the type cannot be handled.
   */
  createPermissionPrompt(type, request) {
    switch (type) {
      case "geolocation": {
        return new PermissionUI.GeolocationPermissionPrompt(request);
      }
      case "desktop-notification": {
        return new PermissionUI.DesktopNotificationPermissionPrompt(request);
      }
    }
    return undefined;
  },
};

function ContentPermissionPrompt() {}

ContentPermissionPrompt.prototype = {
  classID:          Components.ID("{d8903bf6-68d5-4e97-bcd1-e4d3012f721a}"),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIContentPermissionPrompt]),

  /**
   * This implementation of nsIContentPermissionPrompt.prompt ensures
   * that there's only one nsIContentPermissionType in the request,
   * and that it's of type nsIContentPermissionType. Failing to
   * satisfy either of these conditions will result in this method
   * throwing NS_ERRORs. If the combined ContentPermissionIntegration
   * cannot construct a prompt for this particular request, an
   * NS_ERROR_FAILURE will be thrown.
   *
   * Any time an error is thrown, the nsIContentPermissionRequest is
   * cancelled automatically.
   *
   * @param {nsIContentPermissionRequest} request
   *        The request that we're to show a prompt for.
   */
  prompt(request) {
    try {
      // Only allow exactly one permission request here.
      let types = request.types.QueryInterface(Ci.nsIArray);
      if (types.length != 1) {
        throw Components.Exception(
          "Expected an nsIContentPermissionRequest with only 1 type.",
          Cr.NS_ERROR_UNEXPECTED);
      }

      let type = types.queryElementAt(0, Ci.nsIContentPermissionType).type;
      let combinedIntegration =
        Integration.contentPermission.getCombined(ContentPermissionIntegration);

      let permissionPrompt =
        combinedIntegration.createPermissionPrompt(type, request);
      if (!permissionPrompt) {
        throw Components.Exception(
          `Failed to handle permission of type ${type}`,
          Cr.NS_ERROR_FAILURE);
      }

      permissionPrompt.prompt();
    } catch (ex) {
      Cu.reportError(ex);
      request.cancel();
      throw ex;
    }
  },
};

var DefaultBrowserCheck = {
  get OPTIONPOPUP() { return "defaultBrowserNotificationPopup" },
  _setAsDefaultTimer: null,
  _setAsDefaultButtonClickStartTime: 0,

  closePrompt: function(aNode) {
    if (this._notification) {
      this._notification.close();
    }
  },

  setAsDefault: function() {
    let claimAllTypes = true;
    let setAsDefaultError = false;
#ifdef XP_WIN
    try {
      // In Windows 8+, the UI for selecting default protocol is much
      // nicer than the UI for setting file type associations. So we
      // only show the protocol association screen on Windows 8+.
      // Windows 8 is version 6.2.
      let version = Services.sysinfo.getProperty("version");
      claimAllTypes = (parseFloat(version) < 6.2);
    } catch (ex) { }
#endif
    try {
      ShellService.setDefaultBrowser(claimAllTypes, false);

      if (this._setAsDefaultTimer) {
        this._setAsDefaultTimer.cancel();
      }

      this._setAsDefaultButtonClickStartTime = Math.floor(Date.now() / 1000);
      this._setAsDefaultTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      this._setAsDefaultTimer.init(() => {
        let isDefault = false;
        let isDefaultError = false;
        try {
          isDefault = ShellService.isDefaultBrowser(true, false);
        } catch (ex) {
          isDefaultError = true;
        }

        let now = Math.floor(Date.now() / 1000);
        let runTime = now - this._setAsDefaultButtonClickStartTime;
        if (isDefault || runTime > 600) {
          this._setAsDefaultTimer.cancel();
          this._setAsDefaultTimer = null;
        }
      }, 1000, Ci.nsITimer.TYPE_REPEATING_SLACK);
    } catch (ex) {
      setAsDefaultError = true;
      Cu.reportError(ex);
    }
  },

  _createPopup: function(win, notNowStrings, neverStrings) {
    let doc = win.document;
    let popup = doc.createElement("menupopup");
    popup.id = this.OPTIONPOPUP;

    let notNowItem = doc.createElement("menuitem");
    notNowItem.id = "defaultBrowserNotNow";
    notNowItem.setAttribute("label", notNowStrings.label);
    notNowItem.setAttribute("accesskey", notNowStrings.accesskey);
    popup.appendChild(notNowItem);

    let neverItem = doc.createElement("menuitem");
    neverItem.id = "defaultBrowserNever";
    neverItem.setAttribute("label", neverStrings.label);
    neverItem.setAttribute("accesskey", neverStrings.accesskey);
    popup.appendChild(neverItem);

    popup.addEventListener("command", this);

    let popupset = doc.getElementById("mainPopupSet");
    popupset.appendChild(popup);
  },

  handleEvent: function(event) {
    if (event.type == "command") {
      if (event.target.id == "defaultBrowserNever") {
        ShellService.shouldCheckDefaultBrowser = false;
      }
      this.closePrompt();
    }
  },

  prompt: function(win) {
    let useNotificationBar = Services.prefs.getBoolPref("browser.defaultbrowser.notificationbar");

    let brandBundle = win.document.getElementById("bundle_brand");
    let brandShortName = brandBundle.getString("brandShortName");

    let shellBundle = win.document.getElementById("bundle_shell");
    let buttonPrefix = "setDefaultBrowser" + (useNotificationBar ? "" : "Alert");
    let yesButton = shellBundle.getFormattedString(buttonPrefix + "Confirm.label",
                                                   [brandShortName]);
    let notNowButton = shellBundle.getString(buttonPrefix + "NotNow.label");

    if (useNotificationBar) {
      let promptMessage = shellBundle.getFormattedString("setDefaultBrowserMessage2",
                                                         [brandShortName]);
      let optionsMessage = shellBundle.getString("setDefaultBrowserOptions.label");
      let optionsKey = shellBundle.getString("setDefaultBrowserOptions.accesskey");

      let neverLabel = shellBundle.getString("setDefaultBrowserNever.label");
      let neverKey = shellBundle.getString("setDefaultBrowserNever.accesskey");

      let yesButtonKey = shellBundle.getString("setDefaultBrowserConfirm.accesskey");
      let notNowButtonKey = shellBundle.getString("setDefaultBrowserNotNow.accesskey");

      let notificationBox = win.document.getElementById("high-priority-global-notificationbox");

      this._createPopup(win, {
        label: notNowButton,
        accesskey: notNowButtonKey
      }, {
        label: neverLabel,
        accesskey: neverKey
      });

      let buttons = [
        {
          label: yesButton,
          accessKey: yesButtonKey,
          callback: () => {
            this.setAsDefault();
            this.closePrompt();
          }
        },
        {
          label: optionsMessage,
          accessKey: optionsKey,
          popup: this.OPTIONPOPUP
        }
      ];

      let iconPixels = win.devicePixelRatio > 1 ? "32" : "16";
      let iconURL = "chrome://branding/content/icon" + iconPixels + ".png";
      const priority = notificationBox.PRIORITY_WARNING_HIGH;
      let callback = this._onNotificationEvent.bind(this);
      this._notification = notificationBox.appendNotification(promptMessage, "default-browser",
                                                              iconURL, priority, buttons,
                                                              callback);
    } else {
      // Modal prompt
      let promptTitle = shellBundle.getString("setDefaultBrowserTitle");
      let promptMessage = shellBundle.getFormattedString("setDefaultBrowserMessage",
                                                         [brandShortName]);
      let askLabel = shellBundle.getFormattedString("setDefaultBrowserDontAsk",
                                                    [brandShortName]);

      let ps = Services.prompt;
      let shouldAsk = { value: true };
      let buttonFlags = (ps.BUTTON_TITLE_IS_STRING * ps.BUTTON_POS_0) +
                        (ps.BUTTON_TITLE_IS_STRING * ps.BUTTON_POS_1) +
                        ps.BUTTON_POS_0_DEFAULT;
      let rv = ps.confirmEx(win, promptTitle, promptMessage, buttonFlags,
                            yesButton, notNowButton, null, askLabel, shouldAsk);
      if (rv == 0) {
        this.setAsDefault();
      } else if (!shouldAsk.value) {
        ShellService.shouldCheckDefaultBrowser = false;
      }
    }
  },

  _onNotificationEvent: function(eventType) {
    if (eventType == "removed") {
      let doc = this._notification.ownerDocument;
      let popup = doc.getElementById(this.OPTIONPOPUP);
      popup.removeEventListener("command", this);
      popup.remove();
      delete this._notification;
    }
  },
};

var components = [BrowserGlue, ContentPermissionPrompt];
this.NSGetFactory = XPCOMUtils.generateNSGetFactory(components);
