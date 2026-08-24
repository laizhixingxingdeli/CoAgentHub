import { objectEntries } from "@scalar/helpers/object/object-entries";
const GROUPED_CLIENTS = {
  c: ["libcurl"],
  clojure: ["clj_http"],
  csharp: ["httpclient", "restsharp"],
  dart: ["http"],
  fsharp: ["httpclient"],
  go: ["native"],
  http: ["http1.1"],
  java: ["asynchttp", "nethttp", "okhttp", "unirest"],
  js: ["axios", "fetch", "jquery", "ofetch", "xhr"],
  kotlin: ["okhttp"],
  node: ["axios", "fetch", "ofetch", "undici"],
  objc: ["nsurlsession"],
  ocaml: ["cohttp"],
  php: ["curl", "guzzle"],
  powershell: ["restmethod", "webrequest"],
  python: ["python3", "requests", "httpx_sync", "httpx_async"],
  r: ["httr"],
  ruby: ["native"],
  rust: ["reqwest"],
  shell: ["curl", "httpie", "wget"],
  swift: ["nsurlsession"]
};
const AVAILABLE_CLIENTS = objectEntries(GROUPED_CLIENTS).flatMap(
  ([group, clients]) => clients.map((client) => `${group}/${client}`)
);
export {
  AVAILABLE_CLIENTS,
  GROUPED_CLIENTS
};
//# sourceMappingURL=snippetz.js.map
