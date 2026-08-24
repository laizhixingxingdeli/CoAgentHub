'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var bundlerPluginCore = require('@sentry/bundler-plugin-core');
var path = require('path');
var uuid = require('uuid');

function _interopNamespace(e) {
  if (e && e.__esModule) return e;
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () { return e[k]; }
        });
      }
    });
  }
  n["default"] = e;
  return Object.freeze(n);
}

var path__namespace = /*#__PURE__*/_interopNamespace(path);

function _iterableToArrayLimit(arr, i) {
  var _i = null == arr ? null : "undefined" != typeof Symbol && arr[Symbol.iterator] || arr["@@iterator"];
  if (null != _i) {
    var _s,
      _e,
      _x,
      _r,
      _arr = [],
      _n = !0,
      _d = !1;
    try {
      if (_x = (_i = _i.call(arr)).next, 0 === i) {
        if (Object(_i) !== _i) return;
        _n = !1;
      } else for (; !(_n = (_s = _x.call(_i)).done) && (_arr.push(_s.value), _arr.length !== i); _n = !0);
    } catch (err) {
      _d = !0, _e = err;
    } finally {
      try {
        if (!_n && null != _i.return && (_r = _i.return(), Object(_r) !== _r)) return;
      } finally {
        if (_d) throw _e;
      }
    }
    return _arr;
  }
}
function ownKeys(object, enumerableOnly) {
  var keys = Object.keys(object);
  if (Object.getOwnPropertySymbols) {
    var symbols = Object.getOwnPropertySymbols(object);
    enumerableOnly && (symbols = symbols.filter(function (sym) {
      return Object.getOwnPropertyDescriptor(object, sym).enumerable;
    })), keys.push.apply(keys, symbols);
  }
  return keys;
}
function _objectSpread2(target) {
  for (var i = 1; i < arguments.length; i++) {
    var source = null != arguments[i] ? arguments[i] : {};
    i % 2 ? ownKeys(Object(source), !0).forEach(function (key) {
      _defineProperty(target, key, source[key]);
    }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)) : ownKeys(Object(source)).forEach(function (key) {
      Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
    });
  }
  return target;
}
function _regeneratorRuntime() {
  _regeneratorRuntime = function () {
    return exports;
  };
  var exports = {},
    Op = Object.prototype,
    hasOwn = Op.hasOwnProperty,
    defineProperty = Object.defineProperty || function (obj, key, desc) {
      obj[key] = desc.value;
    },
    $Symbol = "function" == typeof Symbol ? Symbol : {},
    iteratorSymbol = $Symbol.iterator || "@@iterator",
    asyncIteratorSymbol = $Symbol.asyncIterator || "@@asyncIterator",
    toStringTagSymbol = $Symbol.toStringTag || "@@toStringTag";
  function define(obj, key, value) {
    return Object.defineProperty(obj, key, {
      value: value,
      enumerable: !0,
      configurable: !0,
      writable: !0
    }), obj[key];
  }
  try {
    define({}, "");
  } catch (err) {
    define = function (obj, key, value) {
      return obj[key] = value;
    };
  }
  function wrap(innerFn, outerFn, self, tryLocsList) {
    var protoGenerator = outerFn && outerFn.prototype instanceof Generator ? outerFn : Generator,
      generator = Object.create(protoGenerator.prototype),
      context = new Context(tryLocsList || []);
    return defineProperty(generator, "_invoke", {
      value: makeInvokeMethod(innerFn, self, context)
    }), generator;
  }
  function tryCatch(fn, obj, arg) {
    try {
      return {
        type: "normal",
        arg: fn.call(obj, arg)
      };
    } catch (err) {
      return {
        type: "throw",
        arg: err
      };
    }
  }
  exports.wrap = wrap;
  var ContinueSentinel = {};
  function Generator() {}
  function GeneratorFunction() {}
  function GeneratorFunctionPrototype() {}
  var IteratorPrototype = {};
  define(IteratorPrototype, iteratorSymbol, function () {
    return this;
  });
  var getProto = Object.getPrototypeOf,
    NativeIteratorPrototype = getProto && getProto(getProto(values([])));
  NativeIteratorPrototype && NativeIteratorPrototype !== Op && hasOwn.call(NativeIteratorPrototype, iteratorSymbol) && (IteratorPrototype = NativeIteratorPrototype);
  var Gp = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(IteratorPrototype);
  function defineIteratorMethods(prototype) {
    ["next", "throw", "return"].forEach(function (method) {
      define(prototype, method, function (arg) {
        return this._invoke(method, arg);
      });
    });
  }
  function AsyncIterator(generator, PromiseImpl) {
    function invoke(method, arg, resolve, reject) {
      var record = tryCatch(generator[method], generator, arg);
      if ("throw" !== record.type) {
        var result = record.arg,
          value = result.value;
        return value && "object" == typeof value && hasOwn.call(value, "__await") ? PromiseImpl.resolve(value.__await).then(function (value) {
          invoke("next", value, resolve, reject);
        }, function (err) {
          invoke("throw", err, resolve, reject);
        }) : PromiseImpl.resolve(value).then(function (unwrapped) {
          result.value = unwrapped, resolve(result);
        }, function (error) {
          return invoke("throw", error, resolve, reject);
        });
      }
      reject(record.arg);
    }
    var previousPromise;
    defineProperty(this, "_invoke", {
      value: function (method, arg) {
        function callInvokeWithMethodAndArg() {
          return new PromiseImpl(function (resolve, reject) {
            invoke(method, arg, resolve, reject);
          });
        }
        return previousPromise = previousPromise ? previousPromise.then(callInvokeWithMethodAndArg, callInvokeWithMethodAndArg) : callInvokeWithMethodAndArg();
      }
    });
  }
  function makeInvokeMethod(innerFn, self, context) {
    var state = "suspendedStart";
    return function (method, arg) {
      if ("executing" === state) throw new Error("Generator is already running");
      if ("completed" === state) {
        if ("throw" === method) throw arg;
        return doneResult();
      }
      for (context.method = method, context.arg = arg;;) {
        var delegate = context.delegate;
        if (delegate) {
          var delegateResult = maybeInvokeDelegate(delegate, context);
          if (delegateResult) {
            if (delegateResult === ContinueSentinel) continue;
            return delegateResult;
          }
        }
        if ("next" === context.method) context.sent = context._sent = context.arg;else if ("throw" === context.method) {
          if ("suspendedStart" === state) throw state = "completed", context.arg;
          context.dispatchException(context.arg);
        } else "return" === context.method && context.abrupt("return", context.arg);
        state = "executing";
        var record = tryCatch(innerFn, self, context);
        if ("normal" === record.type) {
          if (state = context.done ? "completed" : "suspendedYield", record.arg === ContinueSentinel) continue;
          return {
            value: record.arg,
            done: context.done
          };
        }
        "throw" === record.type && (state = "completed", context.method = "throw", context.arg = record.arg);
      }
    };
  }
  function maybeInvokeDelegate(delegate, context) {
    var methodName = context.method,
      method = delegate.iterator[methodName];
    if (undefined === method) return context.delegate = null, "throw" === methodName && delegate.iterator.return && (context.method = "return", context.arg = undefined, maybeInvokeDelegate(delegate, context), "throw" === context.method) || "return" !== methodName && (context.method = "throw", context.arg = new TypeError("The iterator does not provide a '" + methodName + "' method")), ContinueSentinel;
    var record = tryCatch(method, delegate.iterator, context.arg);
    if ("throw" === record.type) return context.method = "throw", context.arg = record.arg, context.delegate = null, ContinueSentinel;
    var info = record.arg;
    return info ? info.done ? (context[delegate.resultName] = info.value, context.next = delegate.nextLoc, "return" !== context.method && (context.method = "next", context.arg = undefined), context.delegate = null, ContinueSentinel) : info : (context.method = "throw", context.arg = new TypeError("iterator result is not an object"), context.delegate = null, ContinueSentinel);
  }
  function pushTryEntry(locs) {
    var entry = {
      tryLoc: locs[0]
    };
    1 in locs && (entry.catchLoc = locs[1]), 2 in locs && (entry.finallyLoc = locs[2], entry.afterLoc = locs[3]), this.tryEntries.push(entry);
  }
  function resetTryEntry(entry) {
    var record = entry.completion || {};
    record.type = "normal", delete record.arg, entry.completion = record;
  }
  function Context(tryLocsList) {
    this.tryEntries = [{
      tryLoc: "root"
    }], tryLocsList.forEach(pushTryEntry, this), this.reset(!0);
  }
  function values(iterable) {
    if (iterable) {
      var iteratorMethod = iterable[iteratorSymbol];
      if (iteratorMethod) return iteratorMethod.call(iterable);
      if ("function" == typeof iterable.next) return iterable;
      if (!isNaN(iterable.length)) {
        var i = -1,
          next = function next() {
            for (; ++i < iterable.length;) if (hasOwn.call(iterable, i)) return next.value = iterable[i], next.done = !1, next;
            return next.value = undefined, next.done = !0, next;
          };
        return next.next = next;
      }
    }
    return {
      next: doneResult
    };
  }
  function doneResult() {
    return {
      value: undefined,
      done: !0
    };
  }
  return GeneratorFunction.prototype = GeneratorFunctionPrototype, defineProperty(Gp, "constructor", {
    value: GeneratorFunctionPrototype,
    configurable: !0
  }), defineProperty(GeneratorFunctionPrototype, "constructor", {
    value: GeneratorFunction,
    configurable: !0
  }), GeneratorFunction.displayName = define(GeneratorFunctionPrototype, toStringTagSymbol, "GeneratorFunction"), exports.isGeneratorFunction = function (genFun) {
    var ctor = "function" == typeof genFun && genFun.constructor;
    return !!ctor && (ctor === GeneratorFunction || "GeneratorFunction" === (ctor.displayName || ctor.name));
  }, exports.mark = function (genFun) {
    return Object.setPrototypeOf ? Object.setPrototypeOf(genFun, GeneratorFunctionPrototype) : (genFun.__proto__ = GeneratorFunctionPrototype, define(genFun, toStringTagSymbol, "GeneratorFunction")), genFun.prototype = Object.create(Gp), genFun;
  }, exports.awrap = function (arg) {
    return {
      __await: arg
    };
  }, defineIteratorMethods(AsyncIterator.prototype), define(AsyncIterator.prototype, asyncIteratorSymbol, function () {
    return this;
  }), exports.AsyncIterator = AsyncIterator, exports.async = function (innerFn, outerFn, self, tryLocsList, PromiseImpl) {
    void 0 === PromiseImpl && (PromiseImpl = Promise);
    var iter = new AsyncIterator(wrap(innerFn, outerFn, self, tryLocsList), PromiseImpl);
    return exports.isGeneratorFunction(outerFn) ? iter : iter.next().then(function (result) {
      return result.done ? result.value : iter.next();
    });
  }, defineIteratorMethods(Gp), define(Gp, toStringTagSymbol, "Generator"), define(Gp, iteratorSymbol, function () {
    return this;
  }), define(Gp, "toString", function () {
    return "[object Generator]";
  }), exports.keys = function (val) {
    var object = Object(val),
      keys = [];
    for (var key in object) keys.push(key);
    return keys.reverse(), function next() {
      for (; keys.length;) {
        var key = keys.pop();
        if (key in object) return next.value = key, next.done = !1, next;
      }
      return next.done = !0, next;
    };
  }, exports.values = values, Context.prototype = {
    constructor: Context,
    reset: function (skipTempReset) {
      if (this.prev = 0, this.next = 0, this.sent = this._sent = undefined, this.done = !1, this.delegate = null, this.method = "next", this.arg = undefined, this.tryEntries.forEach(resetTryEntry), !skipTempReset) for (var name in this) "t" === name.charAt(0) && hasOwn.call(this, name) && !isNaN(+name.slice(1)) && (this[name] = undefined);
    },
    stop: function () {
      this.done = !0;
      var rootRecord = this.tryEntries[0].completion;
      if ("throw" === rootRecord.type) throw rootRecord.arg;
      return this.rval;
    },
    dispatchException: function (exception) {
      if (this.done) throw exception;
      var context = this;
      function handle(loc, caught) {
        return record.type = "throw", record.arg = exception, context.next = loc, caught && (context.method = "next", context.arg = undefined), !!caught;
      }
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i],
          record = entry.completion;
        if ("root" === entry.tryLoc) return handle("end");
        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc"),
            hasFinally = hasOwn.call(entry, "finallyLoc");
          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) return handle(entry.catchLoc, !0);
            if (this.prev < entry.finallyLoc) return handle(entry.finallyLoc);
          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) return handle(entry.catchLoc, !0);
          } else {
            if (!hasFinally) throw new Error("try statement without catch or finally");
            if (this.prev < entry.finallyLoc) return handle(entry.finallyLoc);
          }
        }
      }
    },
    abrupt: function (type, arg) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc <= this.prev && hasOwn.call(entry, "finallyLoc") && this.prev < entry.finallyLoc) {
          var finallyEntry = entry;
          break;
        }
      }
      finallyEntry && ("break" === type || "continue" === type) && finallyEntry.tryLoc <= arg && arg <= finallyEntry.finallyLoc && (finallyEntry = null);
      var record = finallyEntry ? finallyEntry.completion : {};
      return record.type = type, record.arg = arg, finallyEntry ? (this.method = "next", this.next = finallyEntry.finallyLoc, ContinueSentinel) : this.complete(record);
    },
    complete: function (record, afterLoc) {
      if ("throw" === record.type) throw record.arg;
      return "break" === record.type || "continue" === record.type ? this.next = record.arg : "return" === record.type ? (this.rval = this.arg = record.arg, this.method = "return", this.next = "end") : "normal" === record.type && afterLoc && (this.next = afterLoc), ContinueSentinel;
    },
    finish: function (finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.finallyLoc === finallyLoc) return this.complete(entry.completion, entry.afterLoc), resetTryEntry(entry), ContinueSentinel;
      }
    },
    catch: function (tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;
          if ("throw" === record.type) {
            var thrown = record.arg;
            resetTryEntry(entry);
          }
          return thrown;
        }
      }
      throw new Error("illegal catch attempt");
    },
    delegateYield: function (iterable, resultName, nextLoc) {
      return this.delegate = {
        iterator: values(iterable),
        resultName: resultName,
        nextLoc: nextLoc
      }, "next" === this.method && (this.arg = undefined), ContinueSentinel;
    }
  }, exports;
}
function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) {
  try {
    var info = gen[key](arg);
    var value = info.value;
  } catch (error) {
    reject(error);
    return;
  }
  if (info.done) {
    resolve(value);
  } else {
    Promise.resolve(value).then(_next, _throw);
  }
}
function _asyncToGenerator(fn) {
  return function () {
    var self = this,
      args = arguments;
    return new Promise(function (resolve, reject) {
      var gen = fn.apply(self, args);
      function _next(value) {
        asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value);
      }
      function _throw(err) {
        asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err);
      }
      _next(undefined);
    });
  };
}
function _defineProperty(obj, key, value) {
  key = _toPropertyKey(key);
  if (key in obj) {
    Object.defineProperty(obj, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  } else {
    obj[key] = value;
  }
  return obj;
}
function _slicedToArray(arr, i) {
  return _arrayWithHoles(arr) || _iterableToArrayLimit(arr, i) || _unsupportedIterableToArray(arr, i) || _nonIterableRest();
}
function _arrayWithHoles(arr) {
  if (Array.isArray(arr)) return arr;
}
function _unsupportedIterableToArray(o, minLen) {
  if (!o) return;
  if (typeof o === "string") return _arrayLikeToArray(o, minLen);
  var n = Object.prototype.toString.call(o).slice(8, -1);
  if (n === "Object" && o.constructor) n = o.constructor.name;
  if (n === "Map" || n === "Set") return Array.from(o);
  if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _arrayLikeToArray(o, minLen);
}
function _arrayLikeToArray(arr, len) {
  if (len == null || len > arr.length) len = arr.length;
  for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i];
  return arr2;
}
function _nonIterableRest() {
  throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}
function _toPrimitive(input, hint) {
  if (typeof input !== "object" || input === null) return input;
  var prim = input[Symbol.toPrimitive];
  if (prim !== undefined) {
    var res = prim.call(input, hint || "default");
    if (typeof res !== "object") return res;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (hint === "string" ? String : Number)(input);
}
function _toPropertyKey(arg) {
  var key = _toPrimitive(arg, "string");
  return typeof key === "symbol" ? key : String(key);
}

function esbuildReleaseInjectionPlugin(injectionCode) {
  var pluginName = "sentry-esbuild-release-injection-plugin";
  var virtualReleaseInjectionFilePath = path__namespace.resolve("_sentry-release-injection-stub"); // needs to be an absolute path for older eslint versions

  return {
    name: pluginName,
    esbuild: {
      setup: function setup(_ref) {
        var initialOptions = _ref.initialOptions,
          onLoad = _ref.onLoad,
          onResolve = _ref.onResolve;
        initialOptions.inject = initialOptions.inject || [];
        initialOptions.inject.push(virtualReleaseInjectionFilePath);
        onResolve({
          filter: /_sentry-release-injection-stub/
        }, function (args) {
          return {
            path: args.path,
            sideEffects: true,
            pluginName: pluginName
          };
        });
        onLoad({
          filter: /_sentry-release-injection-stub/
        }, function () {
          return {
            loader: "js",
            pluginName: pluginName,
            contents: injectionCode
          };
        });
      }
    }
  };
}
function esbuildDebugIdInjectionPlugin(logger) {
  var pluginName = "sentry-esbuild-debug-id-injection-plugin";
  var stubNamespace = "sentry-debug-id-stub";
  return {
    name: pluginName,
    esbuild: {
      setup: function setup(_ref2) {
        var initialOptions = _ref2.initialOptions,
          onLoad = _ref2.onLoad,
          onResolve = _ref2.onResolve;
        if (!initialOptions.bundle) {
          logger.warn("The Sentry esbuild plugin only supports esbuild with `bundle: true` being set in the esbuild build options. Esbuild will probably crash now. Sorry about that. If you need to upload sourcemaps without `bundle: true`, it is recommended to use Sentry CLI instead: https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/cli/");
        }
        onResolve({
          filter: /.*/
        }, function (args) {
          if (args.kind !== "entry-point") {
            return;
          } else {
            var _initialOptions$injec;
            // Injected modules via the esbuild `inject` option do also have `kind == "entry-point"`.
            // We do not want to inject debug IDs into those files because they are already bundled into the entrypoints
            if ((_initialOptions$injec = initialOptions.inject) !== null && _initialOptions$injec !== void 0 && _initialOptions$injec.includes(args.path)) {
              return;
            }
            return {
              pluginName: pluginName,
              // needs to be an abs path, otherwise esbuild will complain
              path: path__namespace.isAbsolute(args.path) ? args.path : path__namespace.join(args.resolveDir, args.path),
              pluginData: {
                isProxyResolver: true,
                originalPath: args.path,
                originalResolveDir: args.resolveDir
              },
              // We need to add a suffix here, otherwise esbuild will mark the entrypoint as resolved and won't traverse
              // the module tree any further down past the proxy module because we're essentially creating a dependency
              // loop back to the proxy module.
              // By setting a suffix we're telling esbuild that the entrypoint and proxy module are two different things,
              // making it re-resolve the entrypoint when it is imported from the proxy module.
              // Super confusing? Yes. Works? Apparently... Let's see.
              suffix: "?sentryProxyModule=true"
            };
          }
        });
        onLoad({
          filter: /.*/
        }, function (args) {
          var _args$pluginData;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          if (!((_args$pluginData = args.pluginData) !== null && _args$pluginData !== void 0 && _args$pluginData.isProxyResolver)) {
            return null;
          }

          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          var originalPath = args.pluginData.originalPath;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          var originalResolveDir = args.pluginData.originalResolveDir;
          return {
            loader: "js",
            pluginName: pluginName,
            // We need to use JSON.stringify below so that any escape backslashes stay escape backslashes, in order not to break paths on windows
            contents: "\n              import \"_sentry-debug-id-injection-stub\";\n              import * as OriginalModule from ".concat(JSON.stringify(originalPath), ";\n              export default OriginalModule.default;\n              export * from ").concat(JSON.stringify(originalPath), ";"),
            resolveDir: originalResolveDir
          };
        });
        onResolve({
          filter: /_sentry-debug-id-injection-stub/
        }, function (args) {
          return {
            path: args.path,
            sideEffects: true,
            pluginName: pluginName,
            namespace: stubNamespace,
            suffix: "?sentry-module-id=" + uuid.v4() // create different module, each time this is resolved
          };
        });

        onLoad({
          filter: /_sentry-debug-id-injection-stub/,
          namespace: stubNamespace
        }, function () {
          return {
            loader: "js",
            pluginName: pluginName,
            contents: bundlerPluginCore.getDebugIdSnippet(uuid.v4())
          };
        });
      }
    }
  };
}
function esbuildModuleMetadataInjectionPlugin(injectionCode) {
  var pluginName = "sentry-esbuild-module-metadata-injection-plugin";
  var stubNamespace = "sentry-module-metadata-stub";
  return {
    name: pluginName,
    esbuild: {
      setup: function setup(_ref3) {
        var initialOptions = _ref3.initialOptions,
          onLoad = _ref3.onLoad,
          onResolve = _ref3.onResolve;
        onResolve({
          filter: /.*/
        }, function (args) {
          if (args.kind !== "entry-point") {
            return;
          } else {
            var _initialOptions$injec2;
            // Injected modules via the esbuild `inject` option do also have `kind == "entry-point"`.
            // We do not want to inject debug IDs into those files because they are already bundled into the entrypoints
            if ((_initialOptions$injec2 = initialOptions.inject) !== null && _initialOptions$injec2 !== void 0 && _initialOptions$injec2.includes(args.path)) {
              return;
            }
            return {
              pluginName: pluginName,
              // needs to be an abs path, otherwise esbuild will complain
              path: path__namespace.isAbsolute(args.path) ? args.path : path__namespace.join(args.resolveDir, args.path),
              pluginData: {
                isMetadataProxyResolver: true,
                originalPath: args.path,
                originalResolveDir: args.resolveDir
              },
              // We need to add a suffix here, otherwise esbuild will mark the entrypoint as resolved and won't traverse
              // the module tree any further down past the proxy module because we're essentially creating a dependency
              // loop back to the proxy module.
              // By setting a suffix we're telling esbuild that the entrypoint and proxy module are two different things,
              // making it re-resolve the entrypoint when it is imported from the proxy module.
              // Super confusing? Yes. Works? Apparently... Let's see.
              suffix: "?sentryMetadataProxyModule=true"
            };
          }
        });
        onLoad({
          filter: /.*/
        }, function (args) {
          var _args$pluginData2;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          if (!((_args$pluginData2 = args.pluginData) !== null && _args$pluginData2 !== void 0 && _args$pluginData2.isMetadataProxyResolver)) {
            return null;
          }

          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          var originalPath = args.pluginData.originalPath;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          var originalResolveDir = args.pluginData.originalResolveDir;
          return {
            loader: "js",
            pluginName: pluginName,
            // We need to use JSON.stringify below so that any escape backslashes stay escape backslashes, in order not to break paths on windows
            contents: "\n              import \"_sentry-module-metadata-injection-stub\";\n              import * as OriginalModule from ".concat(JSON.stringify(originalPath), ";\n              export default OriginalModule.default;\n              export * from ").concat(JSON.stringify(originalPath), ";"),
            resolveDir: originalResolveDir
          };
        });
        onResolve({
          filter: /_sentry-module-metadata-injection-stub/
        }, function (args) {
          return {
            path: args.path,
            sideEffects: true,
            pluginName: pluginName,
            namespace: stubNamespace,
            suffix: "?sentry-module-id=" + uuid.v4() // create different module, each time this is resolved
          };
        });

        onLoad({
          filter: /_sentry-module-metadata-injection-stub/,
          namespace: stubNamespace
        }, function () {
          return {
            loader: "js",
            pluginName: pluginName,
            contents: injectionCode
          };
        });
      }
    }
  };
}
function esbuildDebugIdUploadPlugin(upload, _logger, createDependencyOnBuildArtifacts) {
  var freeGlobalDependencyOnDebugIdSourcemapArtifacts = createDependencyOnBuildArtifacts();
  return {
    name: "sentry-esbuild-debug-id-upload-plugin",
    esbuild: {
      setup: function setup(_ref4) {
        var initialOptions = _ref4.initialOptions,
          onEnd = _ref4.onEnd;
        initialOptions.metafile = true;
        onEnd( /*#__PURE__*/function () {
          var _ref5 = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee(result) {
            var _buildArtifacts;
            return _regeneratorRuntime().wrap(function _callee$(_context) {
              while (1) switch (_context.prev = _context.next) {
                case 0:
                  _context.prev = 0;
                  _buildArtifacts = result.metafile ? Object.keys(result.metafile.outputs) : [];
                  _context.next = 4;
                  return upload(_buildArtifacts);
                case 4:
                  _context.prev = 4;
                  freeGlobalDependencyOnDebugIdSourcemapArtifacts();
                  return _context.finish(4);
                case 7:
                case "end":
                  return _context.stop();
              }
            }, _callee, null, [[0,, 4, 7]]);
          }));
          return function (_x) {
            return _ref5.apply(this, arguments);
          };
        }());
      }
    }
  };
}
function esbuildBundleSizeOptimizationsPlugin(replacementValues) {
  return {
    name: "sentry-esbuild-bundle-size-optimizations-plugin",
    esbuild: {
      setup: function setup(_ref6) {
        var initialOptions = _ref6.initialOptions;
        var replacementStringValues = {};
        Object.entries(replacementValues).forEach(function (_ref7) {
          var _ref8 = _slicedToArray(_ref7, 2),
            key = _ref8[0],
            value = _ref8[1];
          replacementStringValues[key] = JSON.stringify(value);
        });
        initialOptions.define = _objectSpread2(_objectSpread2({}, initialOptions.define), replacementStringValues);
      }
    }
  };
}
var sentryUnplugin = bundlerPluginCore.sentryUnpluginFactory({
  releaseInjectionPlugin: esbuildReleaseInjectionPlugin,
  debugIdInjectionPlugin: esbuildDebugIdInjectionPlugin,
  moduleMetadataInjectionPlugin: esbuildModuleMetadataInjectionPlugin,
  debugIdUploadPlugin: esbuildDebugIdUploadPlugin,
  bundleSizeOptimizationsPlugin: esbuildBundleSizeOptimizationsPlugin
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
var sentryEsbuildPlugin = sentryUnplugin.esbuild;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
var index = sentryUnplugin.esbuild;

Object.defineProperty(exports, 'sentryCliBinaryExists', {
  enumerable: true,
  get: function () { return bundlerPluginCore.sentryCliBinaryExists; }
});
exports["default"] = index;
exports.sentryEsbuildPlugin = sentryEsbuildPlugin;
//# sourceMappingURL=index.js.map
