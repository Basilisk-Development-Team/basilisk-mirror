/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
function testMixedTabs() { return new Promise(function(resolve, reject) {
  const base = "http://127.0.0.1:" + Services.prefs.getIntPref("wpe.test.port") + "/";
  const initialCount = gBrowser.tabs.length;
  let phase = 0, cycles = 0, ticks = 0, previousTitle, stoppedAt;
  function check(test, message) { if (!test) throw new Error(message); }
  ContentEngines.get().loadURI(base + 'a');
  let timer = setInterval(function() {
    try {
      if (++ticks > 720) throw new Error('timeout in phase ' + phase);
      let browser = gBrowser.selectedBrowser;
      let view = ContentEngines.get(browser);
      let title = browser.contentTitle;
      switch (phase) {
        case 0:
          if (!view || view.native.loading || !title.startsWith('Page A')) return;
          check(browser.contentDocument === null && browser.contentWindow === null, 'foreign DOM exposed');
          // Exercise HTTPS formatting without depending on an external server.
          URLBarSetURI(Services.io.newURI('https://example.com/', null, null));
          gURLBar.formatValue();
          ContentEngines.refresh();
          gBrowser.loadURI(base + 'b'); phase++; break;
        case 1:
          if (view.native.loading || !title.startsWith('Page B')) return;
          check(browser.canGoBack, 'missing back state');
          BrowserBack(); phase++; break;
        case 2:
          if (!title.startsWith('Page A') || view.native.loading) return;
          check(browser.canGoForward, 'missing forward state');
          BrowserForward(); phase++; break;
        case 3:
          if (!title.startsWith('Page B') || view.native.loading) return;
          previousTitle = title; BrowserReload(); phase++; break;
        case 4:
          if (title == previousTitle || view.native.loading || !title.startsWith('Page B')) return;
          gBrowser.loadURI(base + 'slow'); phase++; break;
        case 5:
          BrowserStop(); stoppedAt = ticks; phase++; break;
        case 6:
          if (ticks - stoppedAt < 12) return;
          check(!title.startsWith('Page Slow'), 'stop failed');
          view.loadURI(base + 'b'); phase++; break;
        case 7:
          if (view.native.loading || !title.startsWith('Page B')) return;
          check(gURLBar.value == base + 'b', 'URL bar mismatch');
          ContentEngines.switchEngine(gBrowser.selectedTab, 'gecko'); phase++; break;
        case 8:
          if (ContentEngines.engineFor(browser) != 'gecko' || !browser.contentDocument || !title.startsWith('Page B')) return;
          ContentEngines.switchEngine(gBrowser.selectedTab, 'webkit'); phase++; break;
        case 9:
          if (!view || view.native.loading || !title.startsWith('Page B')) return;
          check(gBrowser.tabs.length == initialCount, 'switch changed tab count');
          check(ContentEngines.views.size == 2, 'view leaked across switching');
          if (++cycles < 10) { phase = 7; return; }
          let extra = ContentEngines.open(base + 'a');
          phase++; break;
        case 10:
          if (!view || view.native.loading || !title.startsWith('Page A')) return;
          gBrowser.removeCurrentTab(); phase++; break;
        case 11:
          check(gBrowser.tabs.length == initialCount, 'close changed count');
          check(ContentEngines.views.size == 2, 'view leaked after close');
          clearInterval(timer);
          resolve({navigation:true, reload:true, stop:true, switches:cycles*2, nativeViews:ContentEngines.views.size});
      }
    } catch (error) { clearInterval(timer); reject(error); }
  }, 250);
});

}
