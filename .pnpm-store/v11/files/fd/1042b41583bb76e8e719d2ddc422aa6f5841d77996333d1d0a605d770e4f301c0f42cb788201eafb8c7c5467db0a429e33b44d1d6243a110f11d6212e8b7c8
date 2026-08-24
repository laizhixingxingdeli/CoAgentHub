'use strict';

var utils = require('@sentry/utils');
var core = require('@sentry/core');

function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function isMechanism(value) {
    return (isObject(value) &&
        'handled' in value &&
        typeof value.handled === 'boolean' &&
        'type' in value &&
        typeof value.type === 'string');
}
function containsMechanism(value) {
    return (isObject(value) && 'mechanism' in value && isMechanism(value['mechanism']));
}
/**
 * Tries to find release in a global
 */
function getSentryRelease() {
    // Most of the plugins from https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/ inject SENTRY_RELEASE global to the bundle
    if (utils.GLOBAL_OBJ.SENTRY_RELEASE && utils.GLOBAL_OBJ.SENTRY_RELEASE.id) {
        return utils.GLOBAL_OBJ.SENTRY_RELEASE.id;
    }
}
/**
 * Creates an entry on existing object and returns it, or creates a new object with the entry if it doesn't exist.
 *
 * @param target
 * @param entry
 * @returns Object with new entry.
 */
function setOnOptional(target, entry) {
    if (target !== undefined) {
        target[entry[0]] = entry[1];
        return target;
    }
    else {
        return { [entry[0]]: entry[1] };
    }
}

/**
 * Extracts stack frames from the error.stack string
 */
function parseStackFrames(stackParser, error) {
    return stackParser(error.stack || '', 1);
}
/**
 * There are cases where stacktrace.message is an Event object
 * https://github.com/getsentry/sentry-javascript/issues/1949
 * In this specific case we try to extract stacktrace.message.error.message
 */
function extractMessage(ex) {
    const message = ex && ex.message;
    if (!message) {
        return 'No error message';
    }
    if (message.error && typeof message.error.message === 'string') {
        return message.error.message;
    }
    return message;
}
/**
 * Extracts stack frames from the error and builds a Sentry Exception
 */
function exceptionFromError(stackParser, error) {
    const exception = {
        type: error.name || error.constructor.name,
        value: extractMessage(error),
    };
    const frames = parseStackFrames(stackParser, error);
    if (frames.length) {
        exception.stacktrace = { frames };
    }
    if (exception.type === undefined && exception.value === '') {
        exception.value = 'Unrecoverable error caught';
    }
    return exception;
}
/**
 * Builds and Event from a Exception
 */
function eventFromUnknownInput(sdk, stackParser, exception, hint) {
    let ex;
    const providedMechanism = hint && hint.data && containsMechanism(hint.data)
        ? hint.data.mechanism
        : undefined;
    const mechanism = providedMechanism ?? {
        handled: true,
        type: 'generic',
    };
    if (!utils.isError(exception)) {
        if (utils.isPlainObject(exception)) {
            // This will allow us to group events based on top-level keys
            // which is much better than creating new group when any key/value change
            const message = `Non-Error exception captured with keys: ${utils.extractExceptionKeysForMessage(exception)}`;
            const client = sdk?.getClient();
            const normalizeDepth = client && client.getOptions().normalizeDepth;
            sdk?.setExtra('__serialized__', utils.normalizeToSize(exception, normalizeDepth));
            ex = (hint && hint.syntheticException) || new Error(message);
            ex.message = message;
        }
        else {
            // This handles when someone does: `throw "something awesome";`
            // We use synthesized Error here so we can extract a (rough) stack trace.
            ex = (hint && hint.syntheticException) || new Error(exception);
            ex.message = exception;
        }
        mechanism.synthetic = true;
    }
    else {
        ex = exception;
    }
    const event = {
        exception: {
            values: [exceptionFromError(stackParser, ex)],
        },
    };
    utils.addExceptionTypeValue(event, undefined, undefined);
    utils.addExceptionMechanism(event, mechanism);
    return {
        ...event,
        event_id: hint && hint.event_id,
    };
}
/**
 * Builds and Event from a Message
 */
function eventFromMessage(stackParser, message, level = 'info', hint, attachStacktrace) {
    const event = {
        event_id: hint && hint.event_id,
        level,
        message,
    };
    if (attachStacktrace && hint && hint.syntheticException) {
        const frames = parseStackFrames(stackParser, hint.syntheticException);
        if (frames.length) {
            event.exception = {
                values: [
                    {
                        value: message,
                        stacktrace: { frames },
                    },
                ],
            };
        }
    }
    return event;
}

const DEFAULT_LIMIT$1 = 5;
const linkedErrorsIntegration = core.defineIntegration((options = { limit: DEFAULT_LIMIT$1 }) => {
    return {
        name: 'LinkedErrors',
        processEvent: (event, hint, client) => {
            return handler(client.getOptions().stackParser, options.limit, event, hint);
        },
    };
});
function handler(parser, limit, event, hint) {
    if (!event.exception ||
        !event.exception.values ||
        !hint ||
        !utils.isInstanceOf(hint.originalException, Error)) {
        return event;
    }
    const linkedErrors = walkErrorTree(parser, limit, hint.originalException);
    event.exception.values = [...linkedErrors, ...event.exception.values];
    return event;
}
function walkErrorTree(parser, limit, error, stack = []) {
    if (!utils.isInstanceOf(error.cause, Error) || stack.length + 1 >= limit) {
        return stack;
    }
    const exception = exceptionFromError(parser, error.cause);
    return walkErrorTree(parser, limit, error.cause, [
        exception,
        ...stack,
    ]);
}

const defaultRequestDataOptions = {
    allowedHeaders: ['CF-RAY', 'CF-Worker'],
};
const requestDataIntegration = core.defineIntegration((userOptions = {}) => {
    const options = { ...defaultRequestDataOptions, ...userOptions };
    return {
        name: 'RequestData',
        preprocessEvent: (event) => {
            const { sdkProcessingMetadata } = event;
            if (!sdkProcessingMetadata) {
                return event;
            }
            if ('request' in sdkProcessingMetadata &&
                sdkProcessingMetadata.request instanceof Request) {
                event.request = toEventRequest(sdkProcessingMetadata.request, options);
                event.user = toEventUser(event.user ?? {}, sdkProcessingMetadata.request, options);
            }
            if ('requestData' in sdkProcessingMetadata) {
                if (event.request) {
                    event.request.data = sdkProcessingMetadata.requestData;
                }
                else {
                    event.request = {
                        data: sdkProcessingMetadata.requestData,
                    };
                }
            }
            return event;
        },
    };
});
/**
 * Applies allowlists on existing user object.
 *
 * @param user
 * @param request
 * @param options
 * @returns New copy of user
 */
function toEventUser(user, request, options) {
    const ip_address = request.headers.get('CF-Connecting-IP');
    const { allowedIps } = options;
    const newUser = { ...user };
    if (!('ip_address' in user) && // If ip_address is already set from explicitly called setUser, we don't want to overwrite it
        ip_address &&
        allowedIps !== undefined &&
        testAllowlist(ip_address, allowedIps)) {
        newUser.ip_address = ip_address;
    }
    return Object.keys(newUser).length > 0 ? newUser : undefined;
}
/**
 * Converts data from fetch event's Request to Sentry Request used in Sentry Event
 *
 * @param request Native Request object
 * @param options Integration options
 * @returns Sentry Request object
 */
function toEventRequest(request, options) {
    // Build cookies
    const cookieString = request.headers.get('cookie');
    let cookies = undefined;
    if (cookieString) {
        try {
            cookies = parseCookie(cookieString);
        }
        catch (e) {
            // Cookie string failed to parse, no need to do anything
        }
    }
    const headers = {};
    // Build headers (omit cookie header, because we used it in the previous step)
    for (const [k, v] of request.headers.entries()) {
        if (k !== 'cookie') {
            headers[k] = v;
        }
    }
    const eventRequest = {
        method: request.method,
        cookies,
        headers,
    };
    try {
        const url = new URL(request.url);
        eventRequest.url = `${url.protocol}//${url.hostname}${url.pathname}`;
        eventRequest.query_string = url.search;
    }
    catch (e) {
        // `new URL` failed, let's try to split URL the primitive way
        const qi = request.url.indexOf('?');
        if (qi < 0) {
            // no query string
            eventRequest.url = request.url;
        }
        else {
            eventRequest.url = request.url.substr(0, qi);
            eventRequest.query_string = request.url.substr(qi + 1);
        }
    }
    // Let's try to remove sensitive data from incoming Request
    const { allowedHeaders, allowedCookies, allowedSearchParams } = options;
    if (allowedHeaders !== undefined && eventRequest.headers) {
        eventRequest.headers = applyAllowlistToObject(eventRequest.headers, allowedHeaders);
        if (Object.keys(eventRequest.headers).length === 0) {
            delete eventRequest.headers;
        }
    }
    else {
        delete eventRequest.headers;
    }
    if (allowedCookies !== undefined && eventRequest.cookies) {
        eventRequest.cookies = applyAllowlistToObject(eventRequest.cookies, allowedCookies);
        if (Object.keys(eventRequest.cookies).length === 0) {
            delete eventRequest.cookies;
        }
    }
    else {
        delete eventRequest.cookies;
    }
    if (allowedSearchParams !== undefined) {
        const params = Object.fromEntries(new URLSearchParams(eventRequest.query_string));
        const allowedParams = new URLSearchParams();
        Object.keys(applyAllowlistToObject(params, allowedSearchParams)).forEach((allowedKey) => {
            allowedParams.set(allowedKey, params[allowedKey]);
        });
        eventRequest.query_string = allowedParams.toString();
    }
    else {
        delete eventRequest.query_string;
    }
    return eventRequest;
}
/**
 * Helper function that tests 'allowlist' on string.
 *
 * @param target
 * @param allowlist
 * @returns True if target is allowed.
 */
function testAllowlist(target, allowlist) {
    if (typeof allowlist === 'boolean') {
        return allowlist;
    }
    else if (allowlist instanceof RegExp) {
        return allowlist.test(target);
    }
    else if (Array.isArray(allowlist)) {
        const allowlistLowercased = allowlist.map((item) => item.toLowerCase());
        return allowlistLowercased.includes(target);
    }
    else {
        return false;
    }
}
/**
 * Helper function that applies 'allowlist' to target's entries.
 *
 * @param target
 * @param allowlist
 * @returns New object with allowed keys.
 */
function applyAllowlistToObject(target, allowlist) {
    let predicate = () => false;
    if (typeof allowlist === 'boolean') {
        return allowlist ? target : {};
    }
    else if (allowlist instanceof RegExp) {
        predicate = (item) => allowlist.test(item);
    }
    else if (Array.isArray(allowlist)) {
        const allowlistLowercased = allowlist.map((item) => item.toLowerCase());
        predicate = (item) => allowlistLowercased.includes(item.toLowerCase());
    }
    else {
        return {};
    }
    return Object.keys(target)
        .filter(predicate)
        .reduce((allowed, key) => {
        allowed[key] = target[key];
        return allowed;
    }, {});
}
/**
 * Converts cookie string to an object.
 *
 * @param cookieString
 * @returns Object of cookie entries, or empty object if something went wrong during the conversion.
 */
function parseCookie(cookieString) {
    if (typeof cookieString !== 'string') {
        return {};
    }
    try {
        return cookieString
            .split(';')
            .map((part) => part.split('='))
            .reduce((acc, [cookieKey, cookieValue]) => {
            acc[decodeURIComponent(cookieKey.trim())] = decodeURIComponent(cookieValue.trim());
            return acc;
        }, {});
    }
    catch {
        return {};
    }
}

/**
 * Define an integration function that can be used to create an integration instance.
 * Note that this by design hides the implementation details of the integration, as they are considered internal.
 *
 * Inlined from https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/integration.ts#L165
 */
function defineIntegration(fn) {
    return fn;
}

// Adapted from: https://github.com/getsentry/sentry-javascript/blob/develop/packages/core/src/integrations/zoderrors.ts
const INTEGRATION_NAME = 'ZodErrors';
const DEFAULT_LIMIT = 10;
function originalExceptionIsZodError(originalException) {
    return (utils.isError(originalException) &&
        originalException.name === 'ZodError' &&
        Array.isArray(originalException.issues));
}
/**
 * Formats child objects or arrays to a string
 * that is preserved when sent to Sentry.
 *
 * Without this, we end up with something like this in Sentry:
 *
 * [
 *  [Object],
 *  [Object],
 *  [Object],
 *  [Object]
 * ]
 */
function flattenIssue(issue) {
    return {
        ...issue,
        path: 'path' in issue && Array.isArray(issue.path)
            ? issue.path.join('.')
            : undefined,
        keys: 'keys' in issue ? JSON.stringify(issue.keys) : undefined,
        unionErrors: 'unionErrors' in issue ? JSON.stringify(issue.unionErrors) : undefined,
    };
}
/**
 * Takes ZodError issue path array and returns a flattened version as a string.
 * This makes it easier to display paths within a Sentry error message.
 *
 * Array indexes are normalized to reduce duplicate entries
 *
 * @param path ZodError issue path
 * @returns flattened path
 *
 * @example
 * flattenIssuePath([0, 'foo', 1, 'bar']) // -> '<array>.foo.<array>.bar'
 */
function flattenIssuePath(path) {
    return path
        .map((p) => {
        if (typeof p === 'number') {
            return '<array>';
        }
        else {
            return p;
        }
    })
        .join('.');
}
/**
 * Zod error message is a stringified version of ZodError.issues
 * This doesn't display well in the Sentry UI. Replace it with something shorter.
 */
function formatIssueMessage(zodError) {
    const errorKeyMap = new Set();
    for (const iss of zodError.issues) {
        const issuePath = flattenIssuePath(iss.path);
        if (issuePath.length > 0) {
            errorKeyMap.add(issuePath);
        }
    }
    const errorKeys = Array.from(errorKeyMap);
    if (errorKeys.length === 0) {
        // If there are no keys, then we're likely validating the root
        // variable rather than a key within an object. This attempts
        // to extract what type it was that failed to validate.
        // For example, z.string().parse(123) would return "string" here.
        let rootExpectedType = 'variable';
        if (zodError.issues.length > 0) {
            const iss = zodError.issues[0];
            if (iss !== undefined &&
                'expected' in iss &&
                typeof iss.expected === 'string') {
                rootExpectedType = iss.expected;
            }
        }
        return `Failed to validate ${rootExpectedType}`;
    }
    return `Failed to validate keys: ${utils.truncate(errorKeys.join(', '), 100)}`;
}
/**
 * Applies ZodError issues to an event extra and replaces the error message
 */
function applyZodErrorsToEvent(limit, event, saveAttachments = false, hint) {
    if (!event.exception?.values ||
        !hint.originalException ||
        !originalExceptionIsZodError(hint.originalException) ||
        hint.originalException.issues.length === 0) {
        return event;
    }
    try {
        const issuesToFlatten = saveAttachments
            ? hint.originalException.issues
            : hint.originalException.issues.slice(0, limit);
        const flattenedIssues = issuesToFlatten.map(flattenIssue);
        if (saveAttachments) {
            // Sometimes having the full error details can be helpful.
            // Attachments have much higher limits, so we can include the full list of issues.
            if (!Array.isArray(hint.attachments)) {
                hint.attachments = [];
            }
            hint.attachments.push({
                filename: 'zod_issues.json',
                data: JSON.stringify({
                    issues: flattenedIssues,
                }),
            });
        }
        return {
            ...event,
            exception: {
                ...event.exception,
                values: [
                    {
                        ...event.exception.values[0],
                        value: formatIssueMessage(hint.originalException),
                    },
                    ...event.exception.values.slice(1),
                ],
            },
            extra: {
                ...event.extra,
                'zoderror.issues': flattenedIssues.slice(0, limit),
            },
        };
    }
    catch (e) {
        // Hopefully we never throw errors here, but record it
        // with the event just in case.
        return {
            ...event,
            extra: {
                ...event.extra,
                'zoderrors sentry integration parse error': {
                    message: 'an exception was thrown while processing ZodError within applyZodErrorsToEvent()',
                    error: e instanceof Error
                        ? `${e.name}: ${e.message}\n${e.stack}`
                        : 'unknown',
                },
            },
        };
    }
}
/**
 * Sentry integration to process Zod errors, making them easier to work with in Sentry.
 */
const zodErrorsIntegration = defineIntegration((options = {}) => {
    const limit = options.limit ?? DEFAULT_LIMIT;
    return {
        name: INTEGRATION_NAME,
        processEvent(originalEvent, hint) {
            const processedEvent = applyZodErrorsToEvent(limit, originalEvent, options.saveAttachments, hint);
            return processedEvent;
        },
    };
});

/**
 * Installs integrations on the current scope.
 *
 * @param integrations array of integration instances
 */
function setupIntegrations(integrations, sdk) {
    const integrationIndex = {};
    integrations.forEach((integration) => {
        integrationIndex[integration.name] = integration;
        // `setupOnce` is only called the first time
        if (typeof integration.setupOnce === 'function') {
            integration.setupOnce();
        }
        const client = sdk.getClient();
        if (!client) {
            return;
        }
        // `setup` is run for each client
        if (typeof integration.setup === 'function') {
            integration.setup(client);
        }
        if (typeof integration.preprocessEvent === 'function') {
            const callback = integration.preprocessEvent.bind(integration);
            client.on('preprocessEvent', (event, hint) => callback(event, hint, client));
        }
        if (typeof integration.processEvent === 'function') {
            const callback = integration.processEvent.bind(integration);
            const processor = Object.assign((event, hint) => callback(event, hint, client), {
                id: integration.name,
            });
            client.addEventProcessor(processor);
        }
    });
    return integrationIndex;
}

/**
 * The Cloudflare Workers SDK Client.
 */
class ToucanClient extends core.ServerRuntimeClient {
    /**
     * Some functions need to access the scope (Toucan instance) this client is bound to,
     * but calling 'getCurrentHub()' is unsafe because it uses globals.
     * So we store a reference to the Hub after binding to it and provide it to methods that need it.
     */
    #sdk = null;
    #integrationsInitialized = false;
    /**
     * Creates a new Toucan SDK instance.
     * @param options Configuration options for this SDK.
     */
    constructor(options) {
        options._metadata = options._metadata || {};
        options._metadata.sdk = options._metadata.sdk || {
            name: 'toucan-js',
            packages: [
                {
                    name: 'npm:' + 'toucan-js',
                    version: '4.1.1',
                },
            ],
            version: '4.1.1',
        };
        super(options);
    }
    /**
     * By default, integrations are stored in a global. We want to store them in a local instance because they may have contextual data, such as event request.
     */
    setupIntegrations() {
        if (this._isEnabled() && !this.#integrationsInitialized && this.#sdk) {
            this._integrations = setupIntegrations(this._options.integrations, this.#sdk);
            this.#integrationsInitialized = true;
        }
    }
    eventFromException(exception, hint) {
        return utils.resolvedSyncPromise(eventFromUnknownInput(this.#sdk, this._options.stackParser, exception, hint));
    }
    eventFromMessage(message, level = 'info', hint) {
        return utils.resolvedSyncPromise(eventFromMessage(this._options.stackParser, message, level, hint, this._options.attachStacktrace));
    }
    _prepareEvent(event, hint, scope) {
        event.platform = event.platform || 'javascript';
        if (this.getOptions().request) {
            // Set 'request' on sdkProcessingMetadata to be later processed by RequestData integration
            event.sdkProcessingMetadata = setOnOptional(event.sdkProcessingMetadata, [
                'request',
                this.getOptions().request,
            ]);
        }
        if (this.getOptions().requestData) {
            // Set 'requestData' on sdkProcessingMetadata to be later processed by RequestData integration
            event.sdkProcessingMetadata = setOnOptional(event.sdkProcessingMetadata, [
                'requestData',
                this.getOptions().requestData,
            ]);
        }
        return super._prepareEvent(event, hint, scope);
    }
    getSdk() {
        return this.#sdk;
    }
    setSdk(sdk) {
        this.#sdk = sdk;
    }
    /**
     * Sets the request body context on all future events.
     *
     * @param body Request body.
     * @example
     * const body = await request.text();
     * toucan.setRequestBody(body);
     */
    setRequestBody(body) {
        this.getOptions().requestData = body;
    }
    /**
     * Enable/disable the SDK.
     *
     * @param enabled
     */
    setEnabled(enabled) {
        this.getOptions().enabled = enabled;
    }
}

/**
 * Stack line parser for Cloudflare Workers.
 * This wraps node stack parser and adjusts root paths to match with source maps.
 *
 */
function workersStackLineParser(getModule) {
    const [arg1, arg2] = utils.nodeStackLineParser(getModule);
    const fn = (line) => {
        const result = arg2(line);
        if (result) {
            const filename = result.filename;
            // Workers runtime runs a single bundled file that is always in a virtual root
            result.abs_path =
                filename !== undefined && !filename.startsWith('/')
                    ? `/${filename}`
                    : filename;
            // There is no way to tell what code is in_app and what comes from dependencies (node_modules), since we have one bundled file.
            // So everything is in_app, unless an error comes from runtime function (ie. JSON.parse), which is determined by the presence of filename.
            result.in_app = filename !== undefined;
        }
        return result;
    };
    return [arg1, fn];
}
/**
 * Gets the module from filename.
 *
 * @param filename
 * @returns Module name
 */
function getModule(filename) {
    if (!filename) {
        return;
    }
    // In Cloudflare Workers there is always only one bundled file
    return utils.basename(filename, '.js');
}
/** Cloudflare Workers stack parser */
const defaultStackParser = utils.createStackParser(workersStackLineParser(getModule));

/**
 * Creates a Transport that uses native fetch. This transport automatically extends the Workers lifetime with 'waitUntil'.
 */
function makeFetchTransport(options) {
    function makeRequest({ body, }) {
        try {
            const fetchFn = options.fetcher ?? fetch;
            const request = fetchFn(options.url, {
                method: 'POST',
                headers: options.headers,
                body,
            }).then((response) => {
                return {
                    statusCode: response.status,
                    headers: {
                        'retry-after': response.headers.get('Retry-After'),
                        'x-sentry-rate-limits': response.headers.get('X-Sentry-Rate-Limits'),
                    },
                };
            });
            /**
             * Call waitUntil to extend Workers Event lifetime
             */
            if (options.context) {
                options.context.waitUntil(request);
            }
            return request;
        }
        catch (e) {
            return utils.rejectedSyncPromise(e);
        }
    }
    return core.createTransport(options, makeRequest);
}

/**
 * The Cloudflare Workers SDK.
 */
class Toucan extends core.Scope {
    #options;
    constructor(options) {
        super();
        options.defaultIntegrations =
            options.defaultIntegrations === false
                ? []
                : [
                    ...(Array.isArray(options.defaultIntegrations)
                        ? options.defaultIntegrations
                        : [
                            requestDataIntegration(options.requestDataOptions),
                            linkedErrorsIntegration(),
                            zodErrorsIntegration(),
                        ]),
                ];
        if (options.release === undefined) {
            const detectedRelease = getSentryRelease();
            if (detectedRelease !== undefined) {
                options.release = detectedRelease;
            }
        }
        this.#options = options;
        this.attachNewClient();
    }
    /**
     * Creates new ToucanClient and links it to this instance.
     */
    attachNewClient() {
        const client = new ToucanClient({
            ...this.#options,
            transport: makeFetchTransport,
            integrations: core.getIntegrationsToSetup(this.#options),
            stackParser: utils.stackParserFromStackParserOptions(this.#options.stackParser || defaultStackParser),
            transportOptions: {
                ...this.#options.transportOptions,
                context: this.#options.context,
            },
        });
        this.setClient(client);
        client.setSdk(this);
        client.setupIntegrations();
    }
    /**
     * Sets the request body context on all future events.
     *
     * @param body Request body.
     * @example
     * const body = await request.text();
     * toucan.setRequestBody(body);
     */
    setRequestBody(body) {
        this.getClient()?.setRequestBody(body);
    }
    /**
     * Enable/disable the SDK.
     *
     * @param enabled
     */
    setEnabled(enabled) {
        this.getClient()?.setEnabled(enabled);
    }
    /**
     * Create a cron monitor check in and send it to Sentry.
     *
     * @param checkIn An object that describes a check in.
     * @param upsertMonitorConfig An optional object that describes a monitor config. Use this if you want
     * to create a monitor automatically when sending a check in.
     */
    captureCheckIn(checkIn, monitorConfig, scope) {
        if (checkIn.status === 'in_progress') {
            this.setContext('monitor', { slug: checkIn.monitorSlug });
        }
        const client = this.getClient();
        return client.captureCheckIn(checkIn, monitorConfig, scope);
    }
    /**
     * Add a breadcrumb to the current scope.
     */
    addBreadcrumb(breadcrumb, maxBreadcrumbs = 100) {
        const client = this.getClient();
        const max = client.getOptions().maxBreadcrumbs || maxBreadcrumbs;
        return super.addBreadcrumb(breadcrumb, max);
    }
    /**
     * Clone all data from this instance into a new Toucan instance.
     *
     * @override
     * @returns New Toucan instance.
     */
    clone() {
        // Create new scope using the same options
        const toucan = new Toucan({ ...this.#options });
        // And copy all the scope data
        toucan._breadcrumbs = [...this._breadcrumbs];
        toucan._tags = { ...this._tags };
        toucan._extra = { ...this._extra };
        toucan._contexts = { ...this._contexts };
        toucan._user = this._user;
        toucan._level = this._level;
        toucan._session = this._session;
        toucan._transactionName = this._transactionName;
        toucan._fingerprint = this._fingerprint;
        toucan._eventProcessors = [...this._eventProcessors];
        toucan._requestSession = this._requestSession;
        toucan._attachments = [...this._attachments];
        toucan._sdkProcessingMetadata = { ...this._sdkProcessingMetadata };
        toucan._propagationContext = { ...this._propagationContext };
        toucan._lastEventId = this._lastEventId;
        return toucan;
    }
    /**
     * Creates a new scope with and executes the given operation within.
     * The scope is automatically removed once the operation
     * finishes or throws.
     */
    withScope(callback) {
        const toucan = this.clone();
        return callback(toucan);
    }
}

Object.defineProperty(exports, 'dedupeIntegration', {
  enumerable: true,
  get: function () { return core.dedupeIntegration; }
});
Object.defineProperty(exports, 'extraErrorDataIntegration', {
  enumerable: true,
  get: function () { return core.extraErrorDataIntegration; }
});
Object.defineProperty(exports, 'rewriteFramesIntegration', {
  enumerable: true,
  get: function () { return core.rewriteFramesIntegration; }
});
Object.defineProperty(exports, 'sessionTimingIntegration', {
  enumerable: true,
  get: function () { return core.sessionTimingIntegration; }
});
exports.Toucan = Toucan;
exports.linkedErrorsIntegration = linkedErrorsIntegration;
exports.requestDataIntegration = requestDataIntegration;
exports.zodErrorsIntegration = zodErrorsIntegration;
