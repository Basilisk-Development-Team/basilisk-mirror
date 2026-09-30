/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#include "nsIContentRequestChannel.h"
#include "nsIHttpChannel.h"
#include "nsIURI.h"
#include "nsIHttpHeaderVisitor.h"
#include "nsILoadInfo.h"
#include "nsIWritablePropertyBag.h"
#include "nsHashPropertyBag.h"
#include "nsCOMPtr.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsError.h"
#include "mozilla/ModuleUtils.h"

namespace {
// Principal/security fields belong to the backing load info. Window identities
// come from the engine, never from the empty Gecko bookkeeping document.
class LoadInfoBase : public nsILoadInfo {
public:
  NS_FORWARD_NSILOADINFO(mBacking->)
protected:
  nsCOMPtr<nsILoadInfo> mBacking;
};
class PolicyLoadInfo final : public LoadInfoBase {
public:
  NS_DECL_ISUPPORTS
  PolicyLoadInfo(nsILoadInfo* backing, uint64_t frame, uint64_t parent)
    : mFrame(frame), mParent(parent) { mBacking = backing; }
  NS_IMETHOD GetOuterWindowID(uint64_t* value) override { *value=mFrame; return NS_OK; }
  NS_IMETHOD GetParentOuterWindowID(uint64_t* value) override { *value=mParent; return NS_OK; }
  NS_IMETHOD GetFrameOuterWindowID(uint64_t* value) override { *value=0; return NS_OK; }
private:
  ~PolicyLoadInfo() = default;
  uint64_t mFrame, mParent;
};
NS_IMPL_ISUPPORTS(PolicyLoadInfo, nsILoadInfo)

class ChannelBase : public nsIHttpChannel {
public:
  NS_FORWARD_NSIREQUEST(mBacking->)
  NS_FORWARD_NSICHANNEL(mBacking->)
  NS_FORWARD_NSIHTTPCHANNEL(mHTTP->)
protected:
  nsCOMPtr<nsIChannel> mBacking;
  nsCOMPtr<nsIHttpChannel> mHTTP;
};
class ContentRequestChannel final : public ChannelBase,
                                    public nsIContentRequestChannel,
                                    public nsIWritablePropertyBag {
public:
  struct Header { nsCString name, value; };
  NS_DECL_ISUPPORTS
  NS_FORWARD_NSIPROPERTYBAG(mProperties->)
  NS_FORWARD_NSIWRITABLEPROPERTYBAG(mProperties->)
  NS_IMETHOD Initialize(nsIChannel* backing, uint64_t frame, uint64_t parent) override {
    NS_ENSURE_TRUE(backing && !mBacking, NS_ERROR_INVALID_ARG);
    mHTTP = do_QueryInterface(backing);
    NS_ENSURE_TRUE(mHTTP, NS_ERROR_INVALID_ARG);
    nsCOMPtr<nsILoadInfo> info;
    backing->GetLoadInfo(getter_AddRefs(info));
    NS_ENSURE_TRUE(info, NS_ERROR_INVALID_ARG);
    mBacking = backing;
    mInfo = new PolicyLoadInfo(info, frame, parent);
    mProperties = new nsHashPropertyBag();
    return NS_OK;
  }
  NS_IMETHOD GetChannel(nsIHttpChannel** value) override {
    NS_ENSURE_TRUE(mBacking, NS_ERROR_NOT_INITIALIZED);
    NS_ADDREF(*value = this); return NS_OK;
  }
  NS_IMETHOD GetRedirectURI(nsIURI** value) override { NS_IF_ADDREF(*value=mRedirect); return NS_OK; }
  NS_IMETHOD GetSuspendCount(uint32_t* value) override { *value=mSuspendCount;return NS_OK; }
  NS_IMETHOD GetLoadInfo(nsILoadInfo** value) override { NS_IF_ADDREF(*value=mInfo); return NS_OK; }
  NS_IMETHOD BeginResponse(uint32_t status) override {
    NS_ENSURE_TRUE(mPending, NS_ERROR_NOT_AVAILABLE);
    mResponseStatus=status; mResponse=true; mHeaders.Clear(); return NS_OK;
  }
  NS_IMETHOD Finish() override { mPending=false; if (mBacking) mBacking->SetNotificationCallbacks(nullptr); return NS_OK; }
  NS_IMETHOD IsPending(bool* value) override { *value=mPending; return NS_OK; }
  NS_IMETHOD GetStatus(nsresult* value) override { *value=mStatus; return NS_OK; }
  NS_IMETHOD Cancel(nsresult status) override {
    NS_ENSURE_TRUE(mPending, NS_ERROR_NOT_AVAILABLE);
    mStatus=NS_FAILED(status) ? status : NS_BINDING_ABORTED; return NS_OK;
  }
  NS_IMETHOD RedirectTo(nsIURI* uri) override {
    NS_ENSURE_TRUE(mPending && !mResponse && uri, NS_ERROR_NOT_AVAILABLE);
    mRedirect=uri; return NS_OK;
  }
  // The original engine owns transport. Suspension defers its policy reply;
  // this metadata channel must never open a second request.
  NS_IMETHOD Open(nsIInputStream**) override { return NS_ERROR_NOT_IMPLEMENTED; }
  NS_IMETHOD Open2(nsIInputStream**) override { return NS_ERROR_NOT_IMPLEMENTED; }
  NS_IMETHOD AsyncOpen(nsIStreamListener*, nsISupports*) override { return NS_ERROR_NOT_IMPLEMENTED; }
  NS_IMETHOD AsyncOpen2(nsIStreamListener*) override { return NS_ERROR_NOT_IMPLEMENTED; }
  NS_IMETHOD Suspend() override {
    NS_ENSURE_TRUE(mPending && mSuspendCount<1024,NS_ERROR_NOT_AVAILABLE);
    ++mSuspendCount;return NS_OK;
  }
  NS_IMETHOD Resume() override {
    NS_ENSURE_TRUE(mPending && mSuspendCount,NS_ERROR_NOT_AVAILABLE);
    --mSuspendCount;return NS_OK;
  }
  NS_IMETHOD GetResponseStatus(uint32_t* value) override {
    NS_ENSURE_TRUE(mResponse, NS_ERROR_NOT_AVAILABLE); *value=mResponseStatus; return NS_OK;
  }
  NS_IMETHOD GetResponseStatusText(nsACString& value) override { value.Truncate(); return NS_OK; }
  NS_IMETHOD GetRequestSucceeded(bool* value) override {
    NS_ENSURE_TRUE(mResponse, NS_ERROR_NOT_AVAILABLE); *value=mResponseStatus>=200 && mResponseStatus<300; return NS_OK;
  }
  NS_IMETHOD GetResponseHeader(const nsACString& name, nsACString& value) override {
    return ReadHeader(mHeaders,name,value);
  }
  NS_IMETHOD GetRequestHeader(const nsACString& name, nsACString& value) override {
    return ReadHeader(mRequestHeaders,name,value);
  }
  NS_IMETHOD SetRequestHeader(const nsACString& name, const nsACString& value, bool merge) override {
    NS_ENSURE_TRUE(mPending,NS_ERROR_NOT_AVAILABLE);
    return WriteHeader(mRequestHeaders,name,value,merge);
  }
  NS_IMETHOD VisitRequestHeaders(nsIHttpHeaderVisitor* visitor) override {
    return VisitHeaders(mRequestHeaders,visitor);
  }
  NS_IMETHOD SetEmptyRequestHeader(const nsACString& name) override {
    NS_ENSURE_TRUE(mPending,NS_ERROR_NOT_AVAILABLE);
    nsresult rv=WriteHeader(mRequestHeaders,name,EmptyCString(),false);
    NS_ENSURE_SUCCESS(rv,rv);
    Header* header=mRequestHeaders.AppendElement();header->name=name;return NS_OK;
  }
  static nsresult ReadHeader(nsTArray<Header>& headers,const nsACString& name,nsACString& value) {
    for (auto& header : headers) if (header.name.Equals(name, nsCaseInsensitiveCStringComparator())) {
      value=header.value; return NS_OK;
    }
    return NS_ERROR_NOT_AVAILABLE;
  }
  NS_IMETHOD SetResponseHeader(const nsACString& name, const nsACString& value, bool merge) override {
    NS_ENSURE_TRUE(mPending && mResponse, NS_ERROR_NOT_AVAILABLE);
    return WriteHeader(mHeaders,name,value,merge);
  }
  static nsresult WriteHeader(nsTArray<Header>& headers,const nsACString& name,const nsACString& value,bool merge) {
    NS_ENSURE_TRUE(!name.IsEmpty() && name.FindChar('\r')<0 && name.FindChar('\n')<0 &&
                  value.FindChar('\r')<0 && value.FindChar('\n')<0, NS_ERROR_INVALID_ARG);
    for (uint32_t i=0;i<headers.Length();++i) {
      auto& header=headers[i];
      if (!header.name.Equals(name,nsCaseInsensitiveCStringComparator())) continue;
      if (!merge && value.IsEmpty()) {headers.RemoveElementAt(i);return NS_OK;}
      if (merge && !header.value.IsEmpty()) { header.value.AppendLiteral(", "); header.value.Append(value); }
      else header.value=value;
      return NS_OK;
    }
    if (!value.IsEmpty()) {
      Header* header=headers.AppendElement();header->name=name;header->value=value;
    }
    return NS_OK;
  }
  NS_IMETHOD VisitResponseHeaders(nsIHttpHeaderVisitor* visitor) override {
    return VisitHeaders(mHeaders,visitor);
  }
  static nsresult VisitHeaders(nsTArray<Header>& headers,nsIHttpHeaderVisitor* visitor) {
    NS_ENSURE_ARG_POINTER(visitor);
    for (auto& header : headers) { nsresult rv=visitor->VisitHeader(header.name,header.value); NS_ENSURE_SUCCESS(rv,rv); }
    return NS_OK;
  }
  NS_IMETHOD GetContentLength(int64_t* value) override {
    if (!mResponse) return mBacking->GetContentLength(value);
    nsAutoCString length; nsresult rv=GetResponseHeader(NS_LITERAL_CSTRING("Content-Length"),length);
    *value=NS_SUCCEEDED(rv) ? length.ToInteger64(&rv) : -1;
    if (NS_FAILED(rv)) *value=-1;
    return NS_OK;
  }
private:
  ~ContentRequestChannel() = default;
  nsTArray<Header> mHeaders, mRequestHeaders;
  nsCOMPtr<nsILoadInfo> mInfo;
  nsCOMPtr<nsIURI> mRedirect;
  nsCOMPtr<nsIWritablePropertyBag> mProperties;
  nsresult mStatus=NS_OK;
  uint32_t mResponseStatus=0;
  uint32_t mSuspendCount=0;
  bool mResponse=false, mPending=true;
};
NS_IMPL_ISUPPORTS(ContentRequestChannel, nsIContentRequestChannel, nsIHttpChannel,
                  nsIChannel, nsIRequest, nsIWritablePropertyBag, nsIPropertyBag)
NS_GENERIC_FACTORY_CONSTRUCTOR(ContentRequestChannel)
#define CONTENT_REQUEST_CHANNEL_CID {0x818c1e7f,0xcf0e,0x4869,{0x85,0x5a,0xbe,0x7e,0x82,0xd9,0x15,0x90}}
NS_DEFINE_NAMED_CID(CONTENT_REQUEST_CHANNEL_CID);
const mozilla::Module::CIDEntry cids[] = {
  {&kCONTENT_REQUEST_CHANNEL_CID, false, nullptr, ContentRequestChannelConstructor}, {nullptr}
};
const mozilla::Module::ContractIDEntry contracts[] = {
  {"@basilisk-browser.org/content-request-channel;1", &kCONTENT_REQUEST_CHANNEL_CID}, {nullptr}
};
const mozilla::Module module = {mozilla::Module::kVersion,cids,contracts};
}
NSMODULE_DEFN(ContentRequestChannelModule) = &module;
