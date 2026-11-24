// The secure-context-only surface, as Chromium has it (measured
// 2026-11-23 with secure-context-vs-chromium, which checks this table
// against the browser): what a document that is not a secure context does
// not have. Through the proxy every document is served over https, so a
// page of an http: origin (not loopback) was a secure context — cookieStore,
// crypto.subtle, serviceWorker, WebGPU… where directly there are none
// (spec/SecureContext.agda: a document is a secure context exactly when its
// original URL is trustworthy). For such a document the runtime takes this
// surface away and isSecureContext reads false.

import { nO } from "./intrinsics";
import { wrapAccessor } from "./surface";

/** Own names, by the object they are found on (its prototype chain): Chromium's. */
export const SECURE_ONLY: Record<"window" | "Navigator" | "Document" | "Crypto" | "HTMLElement", readonly string[]> = {
    window: [
    "cookieStore", "ondevicemotion", "ondeviceorientation", "ondeviceorientationabsolute", "onpointerrawupdate", "caches",
    "documentPictureInPicture", "sharedStorage", "AbsoluteOrientationSensor", "Accelerometer", "AudioDecoder", "AudioEncoder",
    "AudioWorklet", "BatteryManager", "Cache", "CacheStorage", "Clipboard", "ClipboardItem", "CookieChangeEvent", "CookieStore",
    "CookieStoreManager", "CreateMonitor", "Credential", "CredentialsContainer", "CryptoKey", "DeviceMotionEvent",
    "DeviceMotionEventAcceleration", "DeviceMotionEventRotationRate", "DeviceOrientationEvent", "FederatedCredential", "GPU", "GPUAdapter",
    "GPUAdapterInfo", "GPUBindGroup", "GPUBindGroupLayout", "GPUBuffer", "GPUBufferUsage", "GPUCanvasContext", "GPUColorWrite",
    "GPUCommandBuffer", "GPUCommandEncoder", "GPUCompilationInfo", "GPUCompilationMessage", "GPUComputePassEncoder", "GPUComputePipeline",
    "GPUDevice", "GPUDeviceLostInfo", "GPUError", "GPUExternalTexture", "GPUInternalError", "GPUMapMode", "GPUOutOfMemoryError",
    "GPUPipelineError", "GPUPipelineLayout", "GPUQuerySet", "GPUQueue", "GPURenderBundle", "GPURenderBundleEncoder",
    "GPURenderPassEncoder", "GPURenderPipeline", "GPUSampler", "GPUShaderModule", "GPUShaderStage", "GPUSupportedFeatures",
    "GPUSupportedLimits", "GPUTexture", "GPUTextureUsage", "GPUTextureView", "GPUUncapturedErrorEvent", "GPUValidationError",
    "GravitySensor", "Gyroscope", "IdleDetector", "ImageCapture", "ImageDecoder", "ImageTrack", "ImageTrackList", "Keyboard",
    "KeyboardLayoutMap", "LinearAccelerationSensor", "MIDIAccess", "MIDIConnectionEvent", "MIDIInput", "MIDIInputMap", "MIDIMessageEvent",
    "MIDIOutput", "MIDIOutputMap", "MIDIPort", "MediaDeviceInfo", "MediaDevices", "MediaKeyMessageEvent", "MediaKeySession",
    "MediaKeyStatusMap", "MediaKeySystemAccess", "MediaKeys", "NavigationPreloadManager", "NavigatorManagedData", "OrientationSensor",
    "PasswordCredential", "ProtectedAudience", "RelativeOrientationSensor", "ScreenDetailed", "ScreenDetails", "Sensor",
    "SensorErrorEvent", "ServiceWorkerRegistration", "StorageManager", "SubtleCrypto", "VideoDecoder", "VideoEncoder", "VirtualKeyboard",
    "WGSLLanguageFeatures", "WebTransport", "WebTransportBidirectionalStream", "WebTransportDatagramDuplexStream", "WebTransportError",
    "Worklet", "XRDOMOverlayState", "XRLayer", "XRWebGLBinding", "AudioPlaybackStats", "AuthenticatorAssertionResponse",
    "AuthenticatorAttestationResponse", "AuthenticatorResponse", "PublicKeyCredential", "CaptureController", "ClipboardChangeEvent",
    "DevicePosture", "DigitalCredential", "DocumentPictureInPicture", "EyeDropper", "FetchLaterResult", "FileSystemDirectoryHandle",
    "FileSystemFileHandle", "FileSystemHandle", "FileSystemWritableFileStream", "FileSystemObserver", "FontData", "HID",
    "HIDConnectionEvent", "HIDDevice", "HIDInputReportEvent", "IdentityCredential", "IdentityCredentialError", "IdentityProvider",
    "NavigatorLogin", "LanguageDetector", "Lock", "LockManager", "ServiceWorker", "ServiceWorkerContainer", "OTPCredential",
    "PaymentAddress", "PaymentRequest", "PaymentRequestUpdateEvent", "PaymentResponse", "PaymentManager", "PaymentMethodChangeEvent",
    "Presentation", "PresentationAvailability", "PresentationConnection", "PresentationConnectionAvailableEvent",
    "PresentationConnectionCloseEvent", "PresentationConnectionList", "PresentationReceiver", "PresentationRequest", "PressureObserver",
    "PressureRecord", "Serial", "SerialPort", "SpeechRecognitionPhrase", "StorageBucket", "StorageBucketManager", "Summarizer",
    "Translator", "USB", "USBAlternateInterface", "USBConfiguration", "USBConnectionEvent", "USBDevice", "USBEndpoint",
    "USBInTransferResult", "USBInterface", "USBIsochronousInTransferPacket", "USBIsochronousInTransferResult",
    "USBIsochronousOutTransferPacket", "USBIsochronousOutTransferResult", "USBOutTransferResult", "WakeLock", "WakeLockSentinel",
    "XRAnchor", "XRAnchorSet", "XRBoundedReferenceSpace", "XRCPUDepthInformation", "XRCamera", "XRDepthInformation", "XRFrame", "XRHand",
    "XRHitTestResult", "XRHitTestSource", "XRInputSource", "XRInputSourceArray", "XRInputSourceEvent", "XRInputSourcesChangeEvent",
    "XRJointPose", "XRJointSpace", "XRLightEstimate", "XRLightProbe", "XRPose", "XRRay", "XRReferenceSpace", "XRReferenceSpaceEvent",
    "XRRenderState", "XRRigidTransform", "XRSession", "XRSessionEvent", "XRSpace", "XRSystem", "XRTransientInputHitTestResult",
    "XRTransientInputHitTestSource", "XRView", "XRViewerPose", "XRViewport", "XRWebGLDepthInformation", "XRWebGLLayer",
    "XRCompositionLayer", "XRProjectionLayer", "XRCubeLayer", "XRCylinderLayer", "XREquirectLayer", "XRLayerEvent", "XRQuadLayer",
    "XRSubImage", "XRWebGLSubImage", "XRPlane", "XRPlaneSet", "XRVisibilityMaskChangeEvent", "fetchLater", "getScreenDetails",
    "queryLocalFonts", "showDirectoryPicker", "showOpenFilePicker", "showSaveFilePicker",
    ],
    Navigator: [
    "deprecatedRunAdAuctionEnforcesKAnonymity", "protectedAudience", "clipboard", "credentials", "keyboard", "managed", "mediaDevices",
    "serviceWorker", "virtualKeyboard", "wakeLock", "deviceMemory", "userAgentData", "locks", "storage", "gpu", "login", "devicePosture",
    "hid", "presentation", "serial", "usb", "xr", "storageBuckets", "adAuctionComponents", "runAdAuction", "canLoadAdAuctionFencedFrame",
    "clearAppBadge", "getBattery", "getUserMedia", "requestMIDIAccess", "requestMediaKeySystemAccess", "setAppBadge", "webkitGetUserMedia",
    "clearOriginJoinedAdInterestGroups", "createAuctionNonce", "joinAdInterestGroup", "leaveAdInterestGroup", "updateAdInterestGroups",
    "deprecatedReplaceInURN", "deprecatedURNToURL", "getInstalledRelatedApps", "getInterestGroupAdAuctionData", "registerProtocolHandler",
    "unregisterProtocolHandler",
    ],
    Document: [
    "onpointerrawupdate", "browsingTopics", "hasPrivateToken", "hasRedemptionRecord",
    ],
    Crypto: [
    "subtle", "randomUUID",
    ],
    HTMLElement: [
    "onpointerrawupdate",
    ],
};

/** Take the surface away from a window whose document is not a secure context. */
export function hideSecureContext(win: Window): void {
    const g = win as unknown as Record<string, { prototype?: object } | undefined>;
    const roots: [object | undefined, readonly string[]][] = [
        [win, SECURE_ONLY.window], [g["Navigator"]?.prototype, SECURE_ONLY.Navigator], [g["Document"]?.prototype, SECURE_ONLY.Document],
        [g["Crypto"]?.prototype, SECURE_ONLY.Crypto], [g["HTMLElement"]?.prototype, SECURE_ONLY.HTMLElement],
    ];
    for (const [root, names] of roots) {
        if (!root) continue;
        for (const name of names) {
            // Wherever on the chain it is (Window.prototype, EventTarget's…).
            for (let o: object | null = root; o !== null; o = nO.getPrototypeOf(o) as object | null) {
                const d = nO.getOwnPropertyDescriptor(o, name);
                if (!d) continue;
                if (d.configurable) try { delete (o as Record<string, unknown>)[name]; } catch { /* stays */ }
                break;
            }
        }
    }
    try { wrapAccessor<boolean>(win, "isSecureContext", { get: () => false }); } catch { /* stays native */ }
}
