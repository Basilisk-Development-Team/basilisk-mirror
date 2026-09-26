// Runs at the backend's real document-start, before the page's script.
var phaseOrder=['start'];
document.documentElement.setAttribute('data-start','yes');
var phaseData=legacyContent.getData('value');
