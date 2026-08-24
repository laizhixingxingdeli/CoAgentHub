import type { Request as HarRequest } from 'har-format';
export type { Param as FormDataParam, PostDataCommon, Request as HarRequest, Response as HarResponse, } from 'har-format';
/**
 * Maps programming languages and environments to their available HTTP clients.
 * Each key is a target (language/environment), and each value is an array of
 * client identifiers in the format `target/client`.
 *
 * This is the source of truth for all supported code generation targets.
 */
export declare const GROUPED_CLIENTS: {
    readonly c: readonly ["libcurl"];
    readonly clojure: readonly ["clj_http"];
    readonly csharp: readonly ["httpclient", "restsharp"];
    readonly dart: readonly ["http"];
    readonly fsharp: readonly ["httpclient"];
    readonly go: readonly ["native"];
    readonly http: readonly ["http1.1"];
    readonly java: readonly ["asynchttp", "nethttp", "okhttp", "unirest"];
    readonly js: readonly ["axios", "fetch", "jquery", "ofetch", "xhr"];
    readonly kotlin: readonly ["okhttp"];
    readonly node: readonly ["axios", "fetch", "ofetch", "undici"];
    readonly objc: readonly ["nsurlsession"];
    readonly ocaml: readonly ["cohttp"];
    readonly php: readonly ["curl", "guzzle"];
    readonly powershell: readonly ["restmethod", "webrequest"];
    readonly python: readonly ["python3", "requests", "httpx_sync", "httpx_async"];
    readonly r: readonly ["httr"];
    readonly ruby: readonly ["native"];
    readonly rust: readonly ["reqwest"];
    readonly shell: readonly ["curl", "httpie", "wget"];
    readonly swift: readonly ["nsurlsession"];
};
/**
 * Flat array of all available client identifiers.
 * Each identifier follows the format `target/client` (e.g., `js/fetch`, `python/requests`).
 */
export declare const AVAILABLE_CLIENTS: ("c/libcurl" | "c/clj_http" | "c/httpclient" | "c/restsharp" | "c/http" | "c/native" | "c/http1.1" | "c/asynchttp" | "c/nethttp" | "c/okhttp" | "c/unirest" | "c/axios" | "c/fetch" | "c/jquery" | "c/ofetch" | "c/xhr" | "c/undici" | "c/nsurlsession" | "c/cohttp" | "c/curl" | "c/guzzle" | "c/restmethod" | "c/webrequest" | "c/python3" | "c/requests" | "c/httpx_sync" | "c/httpx_async" | "c/httr" | "c/reqwest" | "c/httpie" | "c/wget" | "r/libcurl" | "r/clj_http" | "r/httpclient" | "r/restsharp" | "r/http" | "r/native" | "r/http1.1" | "r/asynchttp" | "r/nethttp" | "r/okhttp" | "r/unirest" | "r/axios" | "r/fetch" | "r/jquery" | "r/ofetch" | "r/xhr" | "r/undici" | "r/nsurlsession" | "r/cohttp" | "r/curl" | "r/guzzle" | "r/restmethod" | "r/webrequest" | "r/python3" | "r/requests" | "r/httpx_sync" | "r/httpx_async" | "r/httr" | "r/reqwest" | "r/httpie" | "r/wget" | "go/libcurl" | "go/clj_http" | "go/httpclient" | "go/restsharp" | "go/http" | "go/native" | "go/http1.1" | "go/asynchttp" | "go/nethttp" | "go/okhttp" | "go/unirest" | "go/axios" | "go/fetch" | "go/jquery" | "go/ofetch" | "go/xhr" | "go/undici" | "go/nsurlsession" | "go/cohttp" | "go/curl" | "go/guzzle" | "go/restmethod" | "go/webrequest" | "go/python3" | "go/requests" | "go/httpx_sync" | "go/httpx_async" | "go/httr" | "go/reqwest" | "go/httpie" | "go/wget" | "rust/libcurl" | "rust/clj_http" | "rust/httpclient" | "rust/restsharp" | "rust/http" | "rust/native" | "rust/http1.1" | "rust/asynchttp" | "rust/nethttp" | "rust/okhttp" | "rust/unirest" | "rust/axios" | "rust/fetch" | "rust/jquery" | "rust/ofetch" | "rust/xhr" | "rust/undici" | "rust/nsurlsession" | "rust/cohttp" | "rust/curl" | "rust/guzzle" | "rust/restmethod" | "rust/webrequest" | "rust/python3" | "rust/requests" | "rust/httpx_sync" | "rust/httpx_async" | "rust/httr" | "rust/reqwest" | "rust/httpie" | "rust/wget" | "http/libcurl" | "http/clj_http" | "http/httpclient" | "http/restsharp" | "http/http" | "http/native" | "http/http1.1" | "http/asynchttp" | "http/nethttp" | "http/okhttp" | "http/unirest" | "http/axios" | "http/fetch" | "http/jquery" | "http/ofetch" | "http/xhr" | "http/undici" | "http/nsurlsession" | "http/cohttp" | "http/curl" | "http/guzzle" | "http/restmethod" | "http/webrequest" | "http/python3" | "http/requests" | "http/httpx_sync" | "http/httpx_async" | "http/httr" | "http/reqwest" | "http/httpie" | "http/wget" | "clojure/libcurl" | "clojure/clj_http" | "clojure/httpclient" | "clojure/restsharp" | "clojure/http" | "clojure/native" | "clojure/http1.1" | "clojure/asynchttp" | "clojure/nethttp" | "clojure/okhttp" | "clojure/unirest" | "clojure/axios" | "clojure/fetch" | "clojure/jquery" | "clojure/ofetch" | "clojure/xhr" | "clojure/undici" | "clojure/nsurlsession" | "clojure/cohttp" | "clojure/curl" | "clojure/guzzle" | "clojure/restmethod" | "clojure/webrequest" | "clojure/python3" | "clojure/requests" | "clojure/httpx_sync" | "clojure/httpx_async" | "clojure/httr" | "clojure/reqwest" | "clojure/httpie" | "clojure/wget" | "csharp/libcurl" | "csharp/clj_http" | "csharp/httpclient" | "csharp/restsharp" | "csharp/http" | "csharp/native" | "csharp/http1.1" | "csharp/asynchttp" | "csharp/nethttp" | "csharp/okhttp" | "csharp/unirest" | "csharp/axios" | "csharp/fetch" | "csharp/jquery" | "csharp/ofetch" | "csharp/xhr" | "csharp/undici" | "csharp/nsurlsession" | "csharp/cohttp" | "csharp/curl" | "csharp/guzzle" | "csharp/restmethod" | "csharp/webrequest" | "csharp/python3" | "csharp/requests" | "csharp/httpx_sync" | "csharp/httpx_async" | "csharp/httr" | "csharp/reqwest" | "csharp/httpie" | "csharp/wget" | "dart/libcurl" | "dart/clj_http" | "dart/httpclient" | "dart/restsharp" | "dart/http" | "dart/native" | "dart/http1.1" | "dart/asynchttp" | "dart/nethttp" | "dart/okhttp" | "dart/unirest" | "dart/axios" | "dart/fetch" | "dart/jquery" | "dart/ofetch" | "dart/xhr" | "dart/undici" | "dart/nsurlsession" | "dart/cohttp" | "dart/curl" | "dart/guzzle" | "dart/restmethod" | "dart/webrequest" | "dart/python3" | "dart/requests" | "dart/httpx_sync" | "dart/httpx_async" | "dart/httr" | "dart/reqwest" | "dart/httpie" | "dart/wget" | "fsharp/libcurl" | "fsharp/clj_http" | "fsharp/httpclient" | "fsharp/restsharp" | "fsharp/http" | "fsharp/native" | "fsharp/http1.1" | "fsharp/asynchttp" | "fsharp/nethttp" | "fsharp/okhttp" | "fsharp/unirest" | "fsharp/axios" | "fsharp/fetch" | "fsharp/jquery" | "fsharp/ofetch" | "fsharp/xhr" | "fsharp/undici" | "fsharp/nsurlsession" | "fsharp/cohttp" | "fsharp/curl" | "fsharp/guzzle" | "fsharp/restmethod" | "fsharp/webrequest" | "fsharp/python3" | "fsharp/requests" | "fsharp/httpx_sync" | "fsharp/httpx_async" | "fsharp/httr" | "fsharp/reqwest" | "fsharp/httpie" | "fsharp/wget" | "java/libcurl" | "java/clj_http" | "java/httpclient" | "java/restsharp" | "java/http" | "java/native" | "java/http1.1" | "java/asynchttp" | "java/nethttp" | "java/okhttp" | "java/unirest" | "java/axios" | "java/fetch" | "java/jquery" | "java/ofetch" | "java/xhr" | "java/undici" | "java/nsurlsession" | "java/cohttp" | "java/curl" | "java/guzzle" | "java/restmethod" | "java/webrequest" | "java/python3" | "java/requests" | "java/httpx_sync" | "java/httpx_async" | "java/httr" | "java/reqwest" | "java/httpie" | "java/wget" | "js/libcurl" | "js/clj_http" | "js/httpclient" | "js/restsharp" | "js/http" | "js/native" | "js/http1.1" | "js/asynchttp" | "js/nethttp" | "js/okhttp" | "js/unirest" | "js/axios" | "js/fetch" | "js/jquery" | "js/ofetch" | "js/xhr" | "js/undici" | "js/nsurlsession" | "js/cohttp" | "js/curl" | "js/guzzle" | "js/restmethod" | "js/webrequest" | "js/python3" | "js/requests" | "js/httpx_sync" | "js/httpx_async" | "js/httr" | "js/reqwest" | "js/httpie" | "js/wget" | "kotlin/libcurl" | "kotlin/clj_http" | "kotlin/httpclient" | "kotlin/restsharp" | "kotlin/http" | "kotlin/native" | "kotlin/http1.1" | "kotlin/asynchttp" | "kotlin/nethttp" | "kotlin/okhttp" | "kotlin/unirest" | "kotlin/axios" | "kotlin/fetch" | "kotlin/jquery" | "kotlin/ofetch" | "kotlin/xhr" | "kotlin/undici" | "kotlin/nsurlsession" | "kotlin/cohttp" | "kotlin/curl" | "kotlin/guzzle" | "kotlin/restmethod" | "kotlin/webrequest" | "kotlin/python3" | "kotlin/requests" | "kotlin/httpx_sync" | "kotlin/httpx_async" | "kotlin/httr" | "kotlin/reqwest" | "kotlin/httpie" | "kotlin/wget" | "node/libcurl" | "node/clj_http" | "node/httpclient" | "node/restsharp" | "node/http" | "node/native" | "node/http1.1" | "node/asynchttp" | "node/nethttp" | "node/okhttp" | "node/unirest" | "node/axios" | "node/fetch" | "node/jquery" | "node/ofetch" | "node/xhr" | "node/undici" | "node/nsurlsession" | "node/cohttp" | "node/curl" | "node/guzzle" | "node/restmethod" | "node/webrequest" | "node/python3" | "node/requests" | "node/httpx_sync" | "node/httpx_async" | "node/httr" | "node/reqwest" | "node/httpie" | "node/wget" | "objc/libcurl" | "objc/clj_http" | "objc/httpclient" | "objc/restsharp" | "objc/http" | "objc/native" | "objc/http1.1" | "objc/asynchttp" | "objc/nethttp" | "objc/okhttp" | "objc/unirest" | "objc/axios" | "objc/fetch" | "objc/jquery" | "objc/ofetch" | "objc/xhr" | "objc/undici" | "objc/nsurlsession" | "objc/cohttp" | "objc/curl" | "objc/guzzle" | "objc/restmethod" | "objc/webrequest" | "objc/python3" | "objc/requests" | "objc/httpx_sync" | "objc/httpx_async" | "objc/httr" | "objc/reqwest" | "objc/httpie" | "objc/wget" | "ocaml/libcurl" | "ocaml/clj_http" | "ocaml/httpclient" | "ocaml/restsharp" | "ocaml/http" | "ocaml/native" | "ocaml/http1.1" | "ocaml/asynchttp" | "ocaml/nethttp" | "ocaml/okhttp" | "ocaml/unirest" | "ocaml/axios" | "ocaml/fetch" | "ocaml/jquery" | "ocaml/ofetch" | "ocaml/xhr" | "ocaml/undici" | "ocaml/nsurlsession" | "ocaml/cohttp" | "ocaml/curl" | "ocaml/guzzle" | "ocaml/restmethod" | "ocaml/webrequest" | "ocaml/python3" | "ocaml/requests" | "ocaml/httpx_sync" | "ocaml/httpx_async" | "ocaml/httr" | "ocaml/reqwest" | "ocaml/httpie" | "ocaml/wget" | "php/libcurl" | "php/clj_http" | "php/httpclient" | "php/restsharp" | "php/http" | "php/native" | "php/http1.1" | "php/asynchttp" | "php/nethttp" | "php/okhttp" | "php/unirest" | "php/axios" | "php/fetch" | "php/jquery" | "php/ofetch" | "php/xhr" | "php/undici" | "php/nsurlsession" | "php/cohttp" | "php/curl" | "php/guzzle" | "php/restmethod" | "php/webrequest" | "php/python3" | "php/requests" | "php/httpx_sync" | "php/httpx_async" | "php/httr" | "php/reqwest" | "php/httpie" | "php/wget" | "powershell/libcurl" | "powershell/clj_http" | "powershell/httpclient" | "powershell/restsharp" | "powershell/http" | "powershell/native" | "powershell/http1.1" | "powershell/asynchttp" | "powershell/nethttp" | "powershell/okhttp" | "powershell/unirest" | "powershell/axios" | "powershell/fetch" | "powershell/jquery" | "powershell/ofetch" | "powershell/xhr" | "powershell/undici" | "powershell/nsurlsession" | "powershell/cohttp" | "powershell/curl" | "powershell/guzzle" | "powershell/restmethod" | "powershell/webrequest" | "powershell/python3" | "powershell/requests" | "powershell/httpx_sync" | "powershell/httpx_async" | "powershell/httr" | "powershell/reqwest" | "powershell/httpie" | "powershell/wget" | "python/libcurl" | "python/clj_http" | "python/httpclient" | "python/restsharp" | "python/http" | "python/native" | "python/http1.1" | "python/asynchttp" | "python/nethttp" | "python/okhttp" | "python/unirest" | "python/axios" | "python/fetch" | "python/jquery" | "python/ofetch" | "python/xhr" | "python/undici" | "python/nsurlsession" | "python/cohttp" | "python/curl" | "python/guzzle" | "python/restmethod" | "python/webrequest" | "python/python3" | "python/requests" | "python/httpx_sync" | "python/httpx_async" | "python/httr" | "python/reqwest" | "python/httpie" | "python/wget" | "ruby/libcurl" | "ruby/clj_http" | "ruby/httpclient" | "ruby/restsharp" | "ruby/http" | "ruby/native" | "ruby/http1.1" | "ruby/asynchttp" | "ruby/nethttp" | "ruby/okhttp" | "ruby/unirest" | "ruby/axios" | "ruby/fetch" | "ruby/jquery" | "ruby/ofetch" | "ruby/xhr" | "ruby/undici" | "ruby/nsurlsession" | "ruby/cohttp" | "ruby/curl" | "ruby/guzzle" | "ruby/restmethod" | "ruby/webrequest" | "ruby/python3" | "ruby/requests" | "ruby/httpx_sync" | "ruby/httpx_async" | "ruby/httr" | "ruby/reqwest" | "ruby/httpie" | "ruby/wget" | "shell/libcurl" | "shell/clj_http" | "shell/httpclient" | "shell/restsharp" | "shell/http" | "shell/native" | "shell/http1.1" | "shell/asynchttp" | "shell/nethttp" | "shell/okhttp" | "shell/unirest" | "shell/axios" | "shell/fetch" | "shell/jquery" | "shell/ofetch" | "shell/xhr" | "shell/undici" | "shell/nsurlsession" | "shell/cohttp" | "shell/curl" | "shell/guzzle" | "shell/restmethod" | "shell/webrequest" | "shell/python3" | "shell/requests" | "shell/httpx_sync" | "shell/httpx_async" | "shell/httr" | "shell/reqwest" | "shell/httpie" | "shell/wget" | "swift/libcurl" | "swift/clj_http" | "swift/httpclient" | "swift/restsharp" | "swift/http" | "swift/native" | "swift/http1.1" | "swift/asynchttp" | "swift/nethttp" | "swift/okhttp" | "swift/unirest" | "swift/axios" | "swift/fetch" | "swift/jquery" | "swift/ofetch" | "swift/xhr" | "swift/undici" | "swift/nsurlsession" | "swift/cohttp" | "swift/curl" | "swift/guzzle" | "swift/restmethod" | "swift/webrequest" | "swift/python3" | "swift/requests" | "swift/httpx_sync" | "swift/httpx_async" | "swift/httr" | "swift/reqwest" | "swift/httpie" | "swift/wget")[];
/**
 * All available client identifiers in array format
 * @example
 * ```typescript
 * const clients: AvailableClients = ['js/fetch', 'python/requests', 'shell/curl']
 * ```
 */
export type AvailableClients = typeof AVAILABLE_CLIENTS;
/**
 * A single available client identifier.
 * @example
 * ```typescript
 * const client: AvailableClient = 'js/fetch'
 * ```
 */
export type AvailableClient = AvailableClients[number];
/**
 * A programming language or environment identifier.
 * @example
 * ```typescript
 * const targetId: TargetId = 'js'
 * ```
 */
export type TargetId = keyof typeof GROUPED_CLIENTS;
/**
 * Extracts the client name from a full client identifier for a given target.
 * For example, for target `js`, this extracts `fetch` from `js/fetch`.
 *
 * @template T - The target identifier (e.g., `js`, `python`)
 */
export type ClientId<T extends TargetId> = (typeof GROUPED_CLIENTS)[T][number];
/**
 * Configuration for a specific target (language/environment).
 * Contains metadata about the target and its available clients.
 */
export type Target = {
    [K in TargetId]: {
        /** The unique identifier for this target. */
        key: K;
        /** Human-readable name for the target. */
        title: string;
        /** The default client to use for this target. */
        default: ClientId<K>;
        /** All available client plugins for this target. */
        clients: Plugin[];
    };
}[TargetId];
/**
 * A code generation plugin for a specific HTTP client.
 * Each plugin knows how to convert an HTTP request into source code
 * for its target language and client library.
 */
export type Plugin = {
    /** The language or environment this plugin targets. */
    target: TargetId;
    /** The identifier of the HTTP client within the target. */
    client: ClientId<TargetId>;
    /** Human-readable name for the client. */
    title: string;
    /** Generates source code for the given HTTP request. */
    generate: (request?: Partial<HarRequest>, configuration?: PluginConfiguration) => string;
};
/**
 * Optional configuration that can be passed to any code generation plugin.
 * Plugins may use this to customize the generated code.
 */
export type PluginConfiguration = {
    /** Credentials for HTTP Basic Authentication. */
    auth?: {
        username: string;
        password: string;
    };
};
//# sourceMappingURL=snippetz.d.ts.map