/* Test extension: installed independently of production content runtime. */
var {utils:Cu} = Components;
Cu.import('resource://gre/modules/Services.jsm');
var base;
function startup(data) {base=data.resourceURI.spec;Services.obs.addObserver(observer,'browser-delayed-startup-finished',false);}
var observer={observe(win) {
  win.legacyFixture = {
    open(browser) {return win.LegacyXULContentRuntime.open(browser);},
    uri(name) {return base+name;}
  };
}};
function shutdown() {Services.obs.removeObserver(observer,'browser-delayed-startup-finished');}
function install() {}
function uninstall() {}
