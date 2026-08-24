Object.defineProperty(exports, '__esModule', { value: true });

var useSwr = require('../use-swr-nxrls8uj.js');
var bunchee_group_0 = require('../config-context-s960zqob.js');
var _internal_index = require('../_internal/index.js');

const subscriptionStorage = new WeakMap();
const SUBSCRIPTION_PREFIX = '$sub$';
const subscription = (useSWRNext)=>(_key, subscribe, config)=>{
        const [key, args] = bunchee_group_0.serialize(_key);
        // Prefix the key to avoid conflicts with other SWR resources.
        const subscriptionKey = key ? SUBSCRIPTION_PREFIX + key : undefined;
        const swr = useSWRNext(subscriptionKey, null, config);
        const { cache } = config;
        // Ensure that the subscription state is scoped by the cache boundary, so
        // you can have multiple SWR zones with subscriptions having the same key.
        if (!subscriptionStorage.has(cache)) {
            subscriptionStorage.set(cache, [
                new Map(),
                new Map()
            ]);
        }
        const [subscriptions, disposers] = subscriptionStorage.get(cache);
        bunchee_group_0.useIsomorphicLayoutEffect(()=>{
            if (!subscriptionKey) return;
            const [, set] = bunchee_group_0.createCacheHelper(cache, subscriptionKey);
            const refCount = subscriptions.get(subscriptionKey) || 0;
            const next = (error, data)=>{
                if (error !== null && typeof error !== 'undefined') {
                    set({
                        error
                    });
                } else {
                    set({
                        error: undefined
                    });
                    swr.mutate(data, false);
                }
            };
            // Increment the ref count.
            subscriptions.set(subscriptionKey, refCount + 1);
            if (!refCount) {
                const dispose = subscribe(args, {
                    next
                });
                if (typeof dispose !== 'function') {
                    throw new Error('The `subscribe` function must return a function to unsubscribe.');
                }
                disposers.set(subscriptionKey, dispose);
            }
            return ()=>{
                const count = subscriptions.get(subscriptionKey) - 1;
                subscriptions.set(subscriptionKey, count);
                // Dispose if it's the last one.
                if (!count) {
                    const dispose = disposers.get(subscriptionKey);
                    dispose == null ? void 0 : dispose();
                }
            };
        }, [
            subscriptionKey
        ]);
        return {
            get data () {
                return swr.data;
            },
            get error () {
                return swr.error;
            }
        };
    };
/**
 * A hook to subscribe a SWR resource to an external data source for continuous updates.
 * @experimental This API is experimental and might change in the future.
 * @example
 * ```jsx
 * import useSWRSubscription from 'swr/subscription'
 *
 * const { data, error } = useSWRSubscription(key, (key, { next }) => {
 *   const unsubscribe = dataSource.subscribe(key, (err, data) => {
 *     next(err, data)
 *   })
 *   return unsubscribe
 * })
 * ```
 */ const useSWRSubscription = _internal_index.withMiddleware(useSwr.useSWR, subscription);

exports.default = useSWRSubscription;
exports.subscription = subscription;
