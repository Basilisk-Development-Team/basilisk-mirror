/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "nsIContentMessageBridge.h"
#include "mozilla/dom/File.h"
#include "mozilla/dom/MessagePort.h"
#include "mozilla/dom/DOMTypes.h"
#include "mozilla/gfx/2D.h"
#include "nsFrameMessageManager.h"
#include "mozilla/ModuleUtils.h"
#include "mozilla/ErrorResult.h"
#include "jsapi.h"
#include "nsStyleSheetService.h"
#include "nsIMutableArray.h"
#include "mozilla/CSSStyleSheet.h"
#include "mozilla/StyleSheetInlines.h"
using namespace mozilla;
using namespace mozilla::dom::ipc;
namespace {
class ContentMessageBridge final : public nsIContentMessageBridge,
                                   public MessageManagerCallback {
public:
  NS_DECL_ISUPPORTS
  NS_IMETHOD Initialize(nsIMessageBroadcaster* parent, nsISupports* target,
                        nsIContentMessageListener* listener, bool process) override {
    NS_ENSURE_TRUE(parent && target && listener && !mManager, NS_ERROR_INVALID_ARG);
    mTarget=target; mListener=listener;
    mManager=new nsFrameMessageManager(nullptr,nullptr,
      MM_CHROME | (process ? MM_PROCESSMANAGER : 0));
    if (process) mTarget=static_cast<nsIMessageSender*>(mManager.get());
    mManager->InitWithCallback(this);
    // Window focus and cycle-collection walkers assume registered frame
    // children have nsFrameLoader callbacks. Keep our sender outside that
    // child list, while retaining normal inbound listener propagation.
    mManager->SetParentManager(static_cast<nsFrameMessageManager*>(parent));
    if (process) static_cast<nsFrameMessageManager*>(parent)->AddChildManager(mManager);
    else {
      // A childless broadcaster safely receives inherited LoadFrameScript
      // calls without appearing as a frame-loader leaf to UXP's walkers.
      // Broadcast messages use the existing Gecko frame-loader relay.
      mScriptManager=new nsFrameMessageManager(nullptr,nullptr,MM_CHROME | MM_BROADCASTER);
      mScriptManager->InitWithCallback(this);
      mScriptManager->SetParentManager(static_cast<nsFrameMessageManager*>(parent));
      static_cast<nsFrameMessageManager*>(parent)->AddChildManager(mScriptManager);
    }
    return NS_OK;
  }
  NS_IMETHOD GetManager(nsIMessageSender** result) override {
    NS_IF_ADDREF(*result=mManager); return NS_OK;
  }
  NS_IMETHOD GetUserStyleSheets(nsIArray** result) override {
    nsCOMPtr<nsIStyleSheetService> service=do_GetService(NS_STYLESHEETSERVICE_CONTRACTID);
    NS_ENSURE_TRUE(service,NS_ERROR_NOT_AVAILABLE);
    nsCOMPtr<nsIMutableArray> sheets=do_CreateInstance("@mozilla.org/array;1");
    NS_ENSURE_TRUE(sheets,NS_ERROR_OUT_OF_MEMORY);
    for (const auto& sheet : *nsStyleSheetService::GetInstance()->UserStyleSheets()) {
      sheets->AppendElement(static_cast<nsIDOMCSSStyleSheet*>(sheet->AsConcrete()),false);
    }
    sheets.forget(result);return NS_OK;
  }
  NS_IMETHOD Close() override {
    if (mScriptManager) {mScriptManager->Disconnect();mScriptManager=nullptr;}
    if (mManager) {mManager->SetCallback(nullptr);mManager->Disconnect();mManager=nullptr;}
    mTarget=nullptr;mListener=nullptr;return NS_OK;
  }
  NS_IMETHOD ReceiveMessage(const nsAString& name, JS::Handle<JS::Value> value,
                            bool sync, JSContext* cx, JS::MutableHandle<JS::Value> result) override {
    NS_ENSURE_TRUE(mManager,NS_ERROR_NOT_AVAILABLE);
    StructuredCloneData data;
    ErrorResult error;
    data.Write(cx,value,error);
    if (error.Failed()) return error.StealNSResult();
    nsTArray<StructuredCloneData> replies;
    RefPtr<nsFrameMessageManager> manager=mManager;
    nsresult rv=manager->ReceiveMessage(mTarget,nullptr,name,sync,&data,nullptr,nullptr,sync ? &replies : nullptr);
    NS_ENSURE_SUCCESS(rv,rv);
    JS::Rooted<JSObject*> array(cx,JS_NewArrayObject(cx,replies.Length()));
    NS_ENSURE_TRUE(array,NS_ERROR_OUT_OF_MEMORY);
    for (uint32_t i=0;i<replies.Length();++i) {
      JS::Rooted<JS::Value> reply(cx);
      replies[i].Read(cx,&reply,error);
      if (error.Failed()) return error.StealNSResult();
      if (!JS_SetElement(cx,array,i,reply)) return NS_ERROR_FAILURE;
    }
    result.setObject(*array);return NS_OK;
  }
  bool DoLoadMessageManagerScript(const nsAString& uri,bool global) override {
    return mListener && NS_SUCCEEDED(mListener->LoadScript(uri,global));
  }
  nsresult DoSendAsyncMessage(JSContext* cx,const nsAString& name,StructuredCloneData& data,
                             JS::Handle<JSObject*>,nsIPrincipal*) override {
    NS_ENSURE_TRUE(mListener,NS_ERROR_NOT_AVAILABLE);
    JS::Rooted<JS::Value> value(cx);
    ErrorResult error;data.Read(cx,&value,error);
    if (error.Failed()) return error.StealNSResult();
    return mListener->SendMessage(name,value);
  }
private:
  ~ContentMessageBridge() {Close();}
  RefPtr<nsFrameMessageManager> mManager;
  RefPtr<nsFrameMessageManager> mScriptManager;
  nsCOMPtr<nsISupports> mTarget;
  nsCOMPtr<nsIContentMessageListener> mListener;
};
NS_IMPL_ISUPPORTS(ContentMessageBridge,nsIContentMessageBridge)
NS_GENERIC_FACTORY_CONSTRUCTOR(ContentMessageBridge)
#define CONTENT_MESSAGE_BRIDGE_CID {0xda34ed6d,0x9764,0x461d,{0xbd,0x69,0x64,0x03,0x88,0xda,0x40,0x8e}}
NS_DEFINE_NAMED_CID(CONTENT_MESSAGE_BRIDGE_CID);
const mozilla::Module::CIDEntry cids[]={{&kCONTENT_MESSAGE_BRIDGE_CID,false,nullptr,ContentMessageBridgeConstructor},{nullptr}};
const mozilla::Module::ContractIDEntry contracts[]={{"@basilisk-browser.org/content-message-bridge;1",&kCONTENT_MESSAGE_BRIDGE_CID},{nullptr}};
const mozilla::Module module={mozilla::Module::kVersion,cids,contracts};
}
NSMODULE_DEFN(ContentMessageBridgeModule)=&module;
