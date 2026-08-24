Object.defineProperty(exports, '__esModule', { value: true });

var useSwr = require('../use-swr-nxrls8uj.js');
var _internal_index = require('../_internal/index.js');

const immutable = (useSWRNext)=>(key, fetcher, config)=>{
        // Always override all revalidate options.
        config.revalidateOnFocus = false;
        config.revalidateIfStale = false;
        config.revalidateOnReconnect = false;
        config.refreshInterval = 0;
        return useSWRNext(key, fetcher, config);
    };
const useSWRImmutable = _internal_index.withMiddleware(useSwr.useSWR, immutable);

exports.default = useSWRImmutable;
exports.immutable = immutable;
