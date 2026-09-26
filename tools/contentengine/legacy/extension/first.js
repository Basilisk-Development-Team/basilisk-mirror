var fixtureOrder = ['first'];
var fixtureData = legacyContent.getData('value');
addMessageListener('echo', message => sendAsyncMessage('echo', {data:message.data, order:fixtureOrder.join(',')}));
