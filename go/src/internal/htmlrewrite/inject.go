package htmlrewrite

import (
	"encoding/json"
	"fmt"
)

// bootstrapScript returns the literal HTML to splice in just after <head>.
//
// Two synchronous scripts:
//
//  1. <script src="<rewriterJsPath>">   — loads the client runtime
//  2. inline <script>                   — calls $rewriter_init(window, config).inject(),
//     then immediately calls
//     $rewriter.set_location(originalURL) so
//     the runtime's base-URL state is correct
//     before any of the page's own inline
//     scripts run.
//
// Both reference the single public origin (cfg.Proxy.PublicURL).
//
// The set_location call MUST be inline (not in a separate <script src=…>).
// The page's own inline scripts run
// strictly between the HTML parser hitting them and the async script
// returning. If they create resources with relative URLs (Cloudflare's
// /cdn-cgi/challenge-platform/... is the canonical example), the prototype-
// patched setters resolve those relatives against the *default* base URL
// (the proxy origin), producing on-proxy URLs that bypass the rewriter.
// Inlining makes set_location run at the right moment in the parser.
func bootstrapScript(cfg *Config) string {
	configJSON, err := json.Marshal(cfg.ClientPassthrough)
	if err != nil {
		// ClientPassthrough is a plain map; marshal can't fail in practice.
		// Fall back to {} and keep going rather than blow up the response.
		configJSON = []byte(`{}`)
	}

	originalURLLit := jsStringLiteral(cfg.BaseURL.String())

	cookieCall := ""
	if len(cfg.PageCookies) > 0 {
		cookiesJSON, jerr := json.Marshal(cfg.PageCookies)
		if jerr != nil {
			cookiesJSON = []byte(`[]`)
		}
		cookieCall = `$rewriter.set_cookies(` + string(cookiesJSON) + `);`
	}

	return fmt.Sprintf(
		`<script src="%s"></script>`+
			`<script>window.$rewriter=window.$rewriter_init(window,%s).inject();`+
			`$rewriter.set_location(%s);`+
			`%s`+
			`document.currentScript.remove();</script>`,
		cfg.RewriterJSPath,
		string(configJSON),
		string(originalURLLit),
		cookieCall,
	)
}

// challengePathFixScript returns a self-invoking inline <script> injected at
// the very start of <head> on challenge pages (InjectBootstrap=false).
//
// It does two things:
//
//  1. Defines window.$rewriter with a minimal stub so that JS-rewritten
//     challenge scripts (e.g. Cloudflare orchestrate) can call the wrapper
//     functions the AST rewriter emitted. wrap_get_location returns a fake
//     Location object (_wl) whose hostname/href/etc. reflect the upstream
//     origin rather than the proxy. This is the correct approach: the JS
//     rewriter transforms every `location.*` access into
//     `$rewriter.wrap_get_location(location).*`, so providing the right
//     return value from that wrapper is sufficient — no runtime prototype
//     patching needed.
//
//  2. Rewrites absolute-path URLs in HTMLScriptElement.src assignments,
//     window.fetch calls, and XMLHttpRequest.open calls so that challenge
//     resources like /cdn-cgi/challenge-platform/... are fetched through the
//     proxy rather than resolving against the proxy origin directly.
func challengePathFixScript(prefix, cookiePrefix string, debug bool) string {
	lit := string(jsStringLiteral(prefix))

	// document.cookie getter/setter patch: apply the site-namespace prefix on
	// set (so Director's existing prefix-strip forwards the plain name to the
	// upstream), strip it on get (so page JS sees the cookie names as they
	// appear on the real site). Only added when a prefix is provided.
	cookiePatch := ""
	if cookiePrefix != "" {
		cpLit := string(jsStringLiteral(cookiePrefix))
		cookiePatch = `var _cp=` + cpLit + `;` +
			`var _cd=Object.getOwnPropertyDescriptor(Document.prototype,'cookie')||` +
			`Object.getOwnPropertyDescriptor(document,'cookie');` +
			`if(_cd&&_cd.get&&_cd.set){var _cg=_cd.get,_cs=_cd.set;` +
			`Object.defineProperty(document,'cookie',{configurable:true,enumerable:true,` +
			`get:function(){var r=_cg.call(this),o=[];` +
			`if(r){r.split(';').forEach(function(c){` +
			`var t=c.trim();if(t.indexOf(_cp)===0){o.push(t.slice(_cp.length));}});}` +
			`return o.join('; ');},` +
			`set:function(v){_cs.call(this,_cp+v);}});}`
	}

	// debugPatch adds console.log instrumentation when the server runs at debug
	// level. A second XHR.open wrapper stores method+URL on the instance for
	// the send logger. Fetch and cookie set operations are logged verbatim.
	debugPatch := ""
	if debug {
		debugPatch = // Announce shim activation with the prefix and upstream origin.
			`console.log('[crn-chl]','shim active prefix='+_p+' origin='+_origin);` +
				// XHR: add a URL-storing second wrapper around the already-patched open,
				// then wrap send to log dispatch and completion.
				`var _xod=XMLHttpRequest.prototype.open;` +
				`XMLHttpRequest.prototype.open=function(){` +
				`this._crn_m=arguments[0];this._crn_u=arguments[1];` +
				`return _xod.apply(this,arguments);};` +
				`var _xsd=XMLHttpRequest.prototype.send;` +
				`XMLHttpRequest.prototype.send=function(){` +
				`var xhr=this,m=xhr._crn_m||'?',u=xhr._crn_u||'?';` +
				`console.log('[crn-chl]','XHR.send',m,u);` +
				`xhr.addEventListener('load',function(){` +
				`console.log('[crn-chl]','XHR.done',m,u,xhr.status);});` +
				`return _xsd.apply(this,arguments);};` +
				// Fetch: wrap the already-patched window.fetch to log URL and status.
				`var _fed=window.fetch;` +
				`if(typeof _fed==='function'){window.fetch=function(){` +
				`var u=typeof arguments[0]==='string'?arguments[0]:` +
				`(arguments[0]&&arguments[0].url)||'?';` +
				`console.log('[crn-chl]','fetch',u);` +
				`return _fed.apply(window,arguments).then(` +
				`function(r){console.log('[crn-chl]','fetch.done',u,r.status);return r;},` +
				`function(e){console.log('[crn-chl]','fetch.err',u,''+e);throw e;});};}` +
				// Cookie setter: log each document.cookie write (before prefix is applied).
				// Getter is intentionally NOT logged — it fires too often to be useful.
				`var _dcdbg=Object.getOwnPropertyDescriptor(document,'cookie');` +
				`if(_dcdbg&&_dcdbg.set){var _csdbg=_dcdbg.set;` +
				`Object.defineProperty(document,'cookie',{configurable:true,` +
				`enumerable:_dcdbg.enumerable,get:_dcdbg.get,` +
				`set:function(v){` +
				`console.log('[crn-chl]','cookie.set',v.substring(0,120));` +
				`return _csdbg.call(this,v);}});}`
	}

	return `<script>(function(){` +
		`var _p=` + lit + `;` +
		// Derive upstream scheme and host from the proxy prefix
		// "/cyrano/<scheme>/<host>" → _pp[2]=scheme, _pp[3]=hostport
		`var _pp=_p.split('/'),_scheme=_pp[2]||'https',_hostport=_pp[3]||'',` +
		`_hostname=_hostport.split(':')[0],_origin=_scheme+'://'+_hostport;` +
		// Read real proxy location directly — Location properties are non-configurable
		// own getters on the instance, so direct property access is the only
		// reliable way to read them.
		`var _rl=window.location;` +
		// Compute upstream path by stripping the proxy prefix.
		`function _up(){var p=_rl.pathname;return p.indexOf(_p)===0?p.slice(_p.length)||'/':p;}` +
		`function _uhref(){return _origin+_up()+_rl.search+_rl.hash;}` +
		// _f routes any fetchable URL through the proxy:
		//  - absolute path (/foo) → upstream proxy prefix + path
		//  - same-upstream URL (https://claude.ai/foo) → same
		//  - any other http/https URL (e.g. https://challenges.cloudflare.com/foo)
		//    → _rl.origin + /cyrano/<scheme>/<host><path>
		// The leading /cyrano/ check and the _rl.host guard (third branch) both
		// prevent double-proxying already-rewritten URLs — needed now that
		// history.pushState/replaceState (below) can hand this an already-
		// proxified value read back from window.location.pathname.
		`function _f(v){` +
		`if(typeof v!=='string')return v;` +
		`if(v.indexOf('/cyrano/')===0)return v;` +
		`if(v.charAt(0)==='/'&&v.charAt(1)!=='/')return _p+v;` +
		`var _ol=_origin.length;` +
		`if(v.length>_ol&&v.indexOf(_origin)===0&&v.charAt(_ol)==='/')return _p+v.slice(_ol);` +
		`var _hi=v.indexOf('://');` +
		`if(_hi>0){var _sch=v.slice(0,_hi);` +
		`if(_sch==='http'||_sch==='https'){` +
		`var _rest=v.slice(_hi+3),_sl=_rest.indexOf('/');` +
		`var _fh=_sl>=0?_rest.slice(0,_sl):_rest,_fp=_sl>=0?_rest.slice(_sl):'/';` +
		`if(_fh!==_rl.host)return _rl.origin+'/cyrano/'+_sch+'/'+_fh+_fp;}}` +
		`return v;}` +
		// _dp reverses _f: given a proxy URL, return the original upstream URL.
		// Used by the script.src getter so that JS code reading back a script's
		// src (e.g. Turnstile's "valid script tag" check) sees the original URL,
		// not the proxy-rewritten one. The browser still fetches via the proxy.
		`function _dp(v){` +
		`var _pf=_rl.origin+'/cyrano/';` +
		`if(typeof v!=='string'||v.indexOf(_pf)!==0)return v;` +
		`var r=v.slice(_pf.length),s=r.indexOf('/');` +
		`if(s<0)return v;` +
		`return r.slice(0,s)+'://'+r.slice(s+1);}` +
		// _stripTT removes require-trusted-types-for and trusted-types directives
		// from a CSP string. Mirrors the server-side rewriteCSP logic, applied to
		// CSP values set dynamically via iframe.csp or setAttribute('csp',…).
		`function _stripTT(v){` +
		`if(typeof v!=='string')return v;` +
		`var ds=v.split(';'),kept=[];` +
		`for(var i=0;i<ds.length;i++){` +
		`var t=ds[i].trim(),sp=t.indexOf(' '),n=(sp<0?t:t.slice(0,sp)).toLowerCase();` +
		`if(n!=='require-trusted-types-for'&&n!=='trusted-types')kept.push(ds[i]);}` +
		`return kept.join(';');}` +
		// _wl: fake Location object returning upstream values.
		// JS-rewritten scripts call $rewriter.wrap_get_location(location).hostname
		// rather than location.hostname directly, so returning _wl from
		// wrap_get_location is enough — no runtime prototype patching needed.
		`var _wl={` +
		`hostname:_hostname,host:_hostport,origin:_origin,` +
		`protocol:_scheme+':',` +
		`port:_hostport.indexOf(':')>=0?_hostport.split(':')[1]:'',` +
		`href:_uhref(),pathname:_up(),search:_rl.search,hash:_rl.hash,` +
		`assign:function(u){_rl.assign(_f(u));},` +
		`replace:function(u){_rl.replace(_f(u));},` +
		`reload:function(){_rl.reload();},` +
		`toString:function(){return _uhref();}};` +
		// $rewriter shim — satisfies every wrap_* call the AST rewriter may have
		// emitted in challenge scripts (orchestrate, jsd, etc.).
		`if(typeof $rewriter==='undefined'){window.$rewriter={` +
		`wrap_get_location:function(l){return _wl;},` +
		`wrap_set_location:function(l,s){return{set value(v){s(_f(v));},get value(){return _wl.href;}};},` +
		`wrap_location:function(a){return{location:_wl};},` +
		`wrap_get_top_window:function(t){return t;},` +
		`wrap_top_window:function(a){return a.obj;},` +
		`wrap_get_parent_window:function(t){return t;},` +
		`wrap_parent_window:function(a){return a.obj;},` +
		`wrap_document_write:function(a){return a.obj;},` +
		`wrap_postMessage:function(a){return a.obj;},` +
		`wrap_eval:function(e){return e;},` +
		`wrap_eval_arg:function(e,a){return e(a);},` +
		`wrap_eval_memexp:function(o){return o;},` +
		`wrap_member_expression:function(o,k){if(k==='location'&&(o===window||o===self||o===document))return{location:_wl};return o;},` +
		`wrap_import_arg:function(s){return typeof s==='string'?_f(s):s;},` +
		`wrap_worker_url:function(u){var s=u!=null?String(u):null;return s?_f(s):u;},` +
		`};}` +
		// document.URL and document.baseURI — these ARE configurable own properties
		// on the document object and can be patched directly.
		`try{var _ud={get:function(){return _uhref();},configurable:true};` +
		`Object.defineProperty(document,'URL',_ud);Object.defineProperty(document,'baseURI',_ud);}catch(e){}` +
		// document.cookie — namespace all JS-set cookies with the site prefix so
		// they can be forwarded to the upstream by the Director (which strips the
		// prefix). The getter strips the prefix so page JS sees plain cookie names.
		cookiePatch +
		// HTMLScriptElement.prototype.src — rewrite on set, de-proxify on get.
		// Setting routes the URL through the proxy so the browser fetches via
		// the proxy. Getting returns the original upstream URL so that third-
		// party scripts (e.g. Turnstile) that check their own script tag's src
		// to validate their load origin see the expected URL, not the proxy URL.
		`var sd=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'src');` +
		`if(sd&&sd.set&&sd.get){var _os=sd.set,_og=sd.get;Object.defineProperty(HTMLScriptElement.prototype,'src',` +
		`{configurable:true,enumerable:sd.enumerable,` +
		`get:function(){return _dp(_og.call(this));},` +
		`set:function(v){_os.call(this,_f(v));}});}` +
		// HTMLIFrameElement.prototype.src — rewrite on set so the browser fetches
		// the frame through the proxy. Without this, JS-created iframes (e.g.
		// Cloudflare Turnstile widget created by orchestrate.js) load directly
		// from the upstream origin, bypassing the proxy and receiving unmodified
		// response headers — including require-trusted-types-for. Also captures
		// a reference to the latest challenges.cloudflare.com iframe element so
		// MessageEvent.source patching can return its contentWindow (the iframe
		// is detached from the DOM by Cloudflare's anti-detection logic, but its
		// contentWindow remains the live message sender).
		`window.__crnCFIframe=null;` +
		`var _ifd=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');` +
		`if(_ifd&&_ifd.set&&_ifd.get){var _ifs=_ifd.set,_ifg=_ifd.get;Object.defineProperty(HTMLIFrameElement.prototype,'src',` +
		`{configurable:true,enumerable:_ifd.enumerable,` +
		`get:function(){return _dp(_ifg.call(this));},` +
		`set:function(v){_ifs.call(this,_f(v));` +
		`if(typeof v==='string'&&v.indexOf('challenges.cloudflare.com')>=0)window.__crnCFIframe=this;}});}` +
		// Location.prototype patches — challenge scripts are NOT JS-rewritten,
		// so calls like location.replace('/login?...') or location.href='...'
		// bypass the $rewriter.wrap_set_location/_wl path and would otherwise
		// navigate to a bare path on the proxy origin (e.g.
		// http://localhost:9081/login?...), losing the /cyrano/<scheme>/<host>
		// prefix. Patch the prototype methods/setters to run URLs through _f.
		`var _lp=Location.prototype;` +
		`var _lr=_lp.replace;` +
		`if(typeof _lr==='function')_lp.replace=function(u){return _lr.call(this,_f(u));};` +
		`var _la=_lp.assign;` +
		`if(typeof _la==='function')_lp.assign=function(u){return _la.call(this,_f(u));};` +
		`var _lhd=Object.getOwnPropertyDescriptor(_lp,'href');` +
		`if(_lhd&&_lhd.set){var _lhs=_lhd.set;` +
		`Object.defineProperty(_lp,'href',{configurable:true,enumerable:_lhd.enumerable,` +
		`get:_lhd.get,set:function(v){_lhs.call(this,_f(v));}});}` +
		// History.prototype.pushState/replaceState — challenge scripts commonly
		// record a completion token in the address bar without a full reload
		// (e.g. history.replaceState(null,'','/?__cf_chl_rt_tk=...')). That's a
		// same-origin, in-page URL change from the browser's perspective — no
		// navigation, no request cyrano ever sees — so unlike location.replace/
		// assign/href above, nothing else catches it. An un-rewritten relative
		// URL here still lands on window.location (pushState/replaceState update
		// it even without navigating), stripping the /cyrano/<scheme>/<host>
		// prefix from the address bar and leaving anything that resolves a
		// relative URL against window.location afterward pointed at the bare
		// proxy origin instead of the upstream site.
		`var _hpo=history.pushState,_hro=history.replaceState;` +
		`if(typeof _hpo==='function')history.pushState=function(d,t,u){` +
		`return _hpo.call(this,d,t,u==null?u:_f(u));};` +
		`if(typeof _hro==='function')history.replaceState=function(d,t,u){` +
		`return _hro.call(this,d,t,u==null?u:_f(u));};` +
		// Element.prototype.setAttribute — intercept src on script/iframe elements
		// and csp on iframe elements. The csp attribute enforces a CSP on the
		// loaded document regardless of its own HTTP headers; strip TT directives
		// so dynamically-created challenge iframes don't impose TT enforcement.
		`var _osa=Element.prototype.setAttribute;` +
		`Element.prototype.setAttribute=function(n,v){` +
		`var a=[];for(var i=0;i<arguments.length;i++)a[i]=arguments[i];` +
		`if(typeof n==='string'){var _nl=n.toLowerCase(),_tg=this.tagName;` +
		`if(_nl==='src'&&(_tg==='SCRIPT'||_tg==='IFRAME')){a[1]=_f(v);` +
		`if(_tg==='IFRAME'&&typeof v==='string'&&v.indexOf('challenges.cloudflare.com')>=0)window.__crnCFIframe=this;}` +
		`if(_nl==='csp')a[1]=_stripTT(v);}` +
		`return _osa.apply(this,a);};` +
		// HTMLIFrameElement.prototype.csp property setter — strip TT directives
		// for direct property assignments (iframe.csp = '...').
		`var _csppd=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'csp');` +
		`if(_csppd&&_csppd.set){var _csps=_csppd.set;` +
		`Object.defineProperty(HTMLIFrameElement.prototype,'csp',{configurable:true,` +
		`enumerable:_csppd.enumerable,get:_csppd.get,` +
		`set:function(v){_csps.call(this,_stripTT(v));}});}` +
		// window.fetch — wrap the function, not the data.
		`var _fe=window.fetch;if(typeof _fe==='function'){window.fetch=function(){` +
		`var a=[];for(var i=0;i<arguments.length;i++)a[i]=arguments[i];` +
		`if(typeof a[0]==='string')a[0]=_f(a[0]);return _fe.apply(window,a);};}` +
		// XMLHttpRequest.prototype.open — wrap the method, not the URL string.
		`var _xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){` +
		`var a=[];for(var i=0;i<arguments.length;i++)a[i]=arguments[i];` +
		`if(typeof a[1]==='string')a[1]=_f(a[1]);return _xo.apply(this,a);};` +
		// window.postMessage — translate any non-proxy target origin to '*' so
		// messages from/to challenge iframes (running at proxy origin) are
		// delivered even when the sender specifies the upstream origin
		// (e.g. 'https://challenges.cloudflare.com') as targetOrigin.
		//
		// Chromium puts postMessage as an OWN property on the window instance,
		// NOT on Window.prototype — patching the prototype does nothing. Cross-
		// realm access (iframe.contentWindow.postMessage from the parent)
		// resolves to the iframe window's own postMessage, so each shim patches
		// its own window.
		`var _wpm=window.postMessage;` +
		`if(typeof _wpm==='function'){window.postMessage=function(){` +
		`var a=[];for(var i=0;i<arguments.length;i++)a[i]=arguments[i];` +
		`if(typeof a[1]==='string'&&a[1]!=='*'&&a[1]!==_rl.origin)a[1]='*';` +
		`return _wpm.apply(this,a);};}` +
		// MessageEvent.prototype.origin — when a message event has origin equal
		// to the proxy origin, reconstruct the real upstream origin.
		//
		// Two recovery paths:
		//  (1) event.data carries a known sender tag (e.g. data.source ===
		//      "cloudflare-challenge" identifies the Turnstile widget). Required
		//      because our window.postMessage wrapper invokes the native call from
		//      its own realm, which makes the browser set event.source to the
		//      wrapper's window — losing the original frame identity. Heuristic
		//      origin recovery from data tags is the only way to get a correct
		//      origin to api.js's allowlist check.
		//  (2) event.source is a child frame whose location is a /cyrano/ URL —
		//      extract the upstream host from the proxy path. Works when the
		//      realm-loss problem doesn't apply (e.g. genuine cross-frame send
		//      with source preserved by the browser).
		`var _med=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'origin');` +
		`if(_med&&_med.get){var _meg=_med.get;` +
		`Object.defineProperty(MessageEvent.prototype,'origin',{configurable:true,` +
		`enumerable:_med.enumerable,` +
		`get:function(){var orig=_meg.call(this);` +
		`if(orig!==_rl.origin)return orig;` +
		`try{var d=this.data;` +
		`if(d&&typeof d==='object'&&d.source==='cloudflare-challenge')` +
		`return 'https://challenges.cloudflare.com';}catch(_e){}` +
		`try{var src=this.source;` +
		`if(src&&src.location){var href=src.location.href,pf=_rl.origin+'/cyrano/';` +
		`if(href.indexOf(pf)===0){` +
		`var r=href.slice(pf.length),si=r.indexOf('/');` +
		`if(si>0){var sch=r.slice(0,si),rest=r.slice(si+1),hi=rest.indexOf('/');` +
		`var host=hi>=0?rest.slice(0,hi):rest;` +
		`return sch+'://'+host;}}}}catch(_e){}` +
		`return orig;}});}` +
		// MessageEvent.prototype.source — companion to the origin patch. api.js
		// validates the source frame identity (event.source === iframe.contentWindow)
		// in addition to origin. Because our window.postMessage wrapper invokes
		// the native call from its own realm, the browser sets event.source to
		// the wrapper's window instead of the real sender iframe. For Cloudflare
		// challenge-tagged messages, find the Turnstile widget iframe in the DOM
		// and return its contentWindow.
		`var _msrcd=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'source');` +
		`if(_msrcd&&_msrcd.get){var _msrcg=_msrcd.get;` +
		`Object.defineProperty(MessageEvent.prototype,'source',{configurable:true,` +
		`enumerable:_msrcd.enumerable,` +
		`get:function(){var origSrc=_msrcg.call(this);` +
		`if(origSrc!==window)return origSrc;` +
		`try{var d=this.data;` +
		`if(d&&typeof d==='object'&&d.source==='cloudflare-challenge'){` +
		`if(window.__crnCFIframe){try{var cw=window.__crnCFIframe.contentWindow;if(cw)return cw;}catch(_e){}}` +
		`var ifs=document.getElementsByTagName('iframe');` +
		`for(var i=0;i<ifs.length;i++){` +
		`var s=ifs[i].getAttribute('src')||'';` +
		`if(s.indexOf('/cyrano/https/challenges.cloudflare.com/')>=0)return ifs[i].contentWindow;}}}catch(_e){}` +
		`return origSrc;}});}` +
		debugPatch +
		`})();</script>`
}

// jsStringLiteral renders s as a double-quoted JS string with the minimum
// set of escapes needed to make any byte sequence safe inside an HTML
// `<script>` block. Includes the `</` → `<\/` escape so a target URL
// containing those characters can't end the script element prematurely.
func jsStringLiteral(s string) []byte {
	out := make([]byte, 0, len(s)+2)
	out = append(out, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		// Defang `</` and `<!--` so the string can't break out of <script>.
		if c == '<' && i+1 < len(s) && (s[i+1] == '/' || s[i+1] == '!') {
			out = append(out, '\\', '<')
			continue
		}
		switch c {
		case '\\', '"':
			out = append(out, '\\', c)
		case '\n':
			out = append(out, '\\', 'n')
		case '\r':
			out = append(out, '\\', 'r')
		case '\t':
			out = append(out, '\\', 't')
		default:
			if c < 0x20 {
				out = append(out, '\\', 'u', '0', '0',
					hexDigit(c>>4), hexDigit(c&0xf))
			} else {
				out = append(out, c)
			}
		}
	}
	out = append(out, '"')
	return out
}

func hexDigit(b byte) byte {
	if b < 10 {
		return '0' + b
	}
	return 'a' + b - 10
}
