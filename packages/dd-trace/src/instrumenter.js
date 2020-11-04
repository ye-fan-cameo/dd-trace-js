'use strict'

const shimmer = require('shimmer')
const log = require('./log')
const platform = require('./platform')
const { isTrue, isFalse } = require('./util')

shimmer({ logger: () => {} })

const plugins = platform.plugins

const disabldPlugins = platform.env('DD_TRACE_DISABLED_PLUGINS')

const collectDisabledPlugins = () => {
  return new Set(disabldPlugins && disabldPlugins.split(',').map(plugin => plugin.trim()))
}

function cleanEnv (name) {
  return platform.env(`DD_TRACE_${name.toUpperCase()}`.replace(/[^a-z0-9_]/ig, '_'))
}

function getConfig (name, config = {}) {
  if (!name) {
    return config
  }

  const enabled = cleanEnv(`${name}_ENABLED`)
  if (enabled !== undefined) {
    config.enabled = isTrue(enabled)
  }

  const analyticsEnabled = cleanEnv(`${name}_ANALYTICS_ENABLED`)
  const analyticsSampleRate = Math.min(Math.max(cleanEnv(`${name}_ANALYTICS_SAMPLE_RATE`), 0), 1)

  if (isFalse(analyticsEnabled)) {
    config.analytics = false
  } else if (!Number.isNaN(analyticsSampleRate)) {
    config.analytics = analyticsSampleRate
  } else if (isTrue(analyticsEnabled)) {
    config.analytics = true
  }

  return config
}

function getPrepatchWrappedFunction (fn) {
  const prepatchWrapped = function prepatchWrapped () {
    const fnToCall = prepatchWrapped._datadog_wrapped || fn
    if (new.target) {
      // eslint-disable-next-line new-cap
      return new fnToCall(...arguments)
    } else {
      return fnToCall.apply(this, arguments)
    }
  }

  // This will be an _actually_ wrapped function once this goes through Instrumenter#wrap
  // TODO should this be non-enumerable, like _datadog_patched?
  prepatchWrapped._datadog_wrapped = fn
  return prepatchWrapped
}

class Instrumenter {
  constructor (tracer) {
    this._tracer = tracer
    this._loader = new platform.Loader(this)
    this._enabled = false
    this._names = new Set()
    this._plugins = new Map()
    this._instrumented = new Map()
    this._disabledPlugins = collectDisabledPlugins()
    this.preload()
  }

  use (name, config) {
    if (typeof config === 'boolean') {
      config = { enabled: config }
    }

    config = getConfig(name, config)

    try {
      this._set(plugins[name.toLowerCase()], { name, config })
    } catch (e) {
      log.debug(`Could not find a plugin named "${name}".`)
    }

    if (this._enabled) {
      this._loader.reload(this._plugins)
    }
  }

  enable (config) {
    config = config || {}

    this._enabled = true

    if (config.plugins !== false) {
      Object.keys(plugins)
        .filter(name => !this._plugins.has(plugins[name]))
        .forEach(name => {
          this._set(plugins[name], { name, config: getConfig(name) })
        })
    }

    this._loader.reload(this._plugins)
  }

  disable () {
    for (const instrumentation of this._instrumented.keys()) {
      this.unpatch(instrumentation)
    }

    this._plugins.clear()
    this._enabled = false
    this._loader.reload(this._plugins)
  }

  wrap (nodules, names, wrapper) {
    nodules = [].concat(nodules)
    names = [].concat(names)

    // Before wrapping/patching anything, we want to make sure that everything
    // we intend to wrap actually exists, and if not, bail without having wrapped anything.
    for (const nodule of nodules) {
      for (const name of names) {
        if (typeof nodule[name] !== 'function') {
          throw new Error(`Expected object ${nodule} to contain method ${name}.`)
        }
      }
    }

    // At this point, we know everything we want to wrap exists, so we can loop
    // again and do the needful wrapping.
    for (const nodule of nodules) {
      for (const name of names) {
        Object.defineProperty(nodule[name], '_datadog_patched', {
          value: true,
          configurable: true
        })

        if (Reflect.ownKeys(nodule[name]).includes('_datadog_wrapped')) {
          nodule[name]._datadog_wrapped = wrapper(nodule[name]._datadog_wrapped)
          return
        }

        shimmer.wrap.call(this, nodule, name, function (original, name) {
          const wrapped = wrapper(original, name)
          const props = Object.getOwnPropertyDescriptors(original)
          const keys = Reflect.ownKeys(props)

          // https://github.com/othiym23/shimmer/issues/19
          for (const key of keys) {
            if (typeof key !== 'symbol' || wrapped.hasOwnProperty(key)) continue

            Object.defineProperty(wrapped, key, props[key])
          }

          return wrapped
        })
      }
    }
  }

  unwrap (nodules, names, wrapper) {
    nodules = [].concat(nodules)
    names = [].concat(names)

    nodules.forEach(nodule => {
      names.forEach(name => {
        if (nodule[name]) {
          nodule[name]._datadog_wrapped = null
        }
        shimmer.unwrap.call(this, nodule, name, wrapper)
        nodule[name] && delete nodule[name]._datadog_patched
      })
    })
  }

  wrapExport (moduleExports, wrapper) {
    if (typeof moduleExports !== 'function') return moduleExports

    const props = Object.keys(moduleExports)
    const shim = function () {
      return moduleExports._datadog_wrapper.apply(this, arguments)
    }

    for (const prop of props) {
      shim[prop] = moduleExports[prop]
    }

    moduleExports._datadog_wrapper = wrapper

    return shim
  }

  unwrapExport (moduleExports) {
    if (moduleExports && moduleExports._datadog_wrapper) {
      moduleExports._datadog_wrapper = moduleExports
    }

    return moduleExports
  }

  load (plugin, meta) {
    if (!this._enabled) return

    const instrumentations = [].concat(plugin)
    const enabled = meta.config.enabled !== false

    platform.metrics().boolean(`datadog.tracer.node.plugin.enabled.by.name`, enabled, `name:${meta.name}`)

    try {
      instrumentations
        .forEach(instrumentation => {
          this._loader.load(instrumentation, meta.config)
        })
    } catch (e) {
      log.error(e)
      this.unload(plugin)
      log.debug(`Error while trying to patch ${meta.name}. The plugin has been disabled.`)

      platform.metrics().increment(`datadog.tracer.node.plugin.errors`, true)
    }
  }

  unload (plugin) {
    [].concat(plugin)
      .forEach(instrumentation => {
        this.unpatch(instrumentation)
        this._instrumented.delete(instrumentation)
      })

    const meta = this._plugins.get(plugin)

    if (meta) {
      this._plugins.delete(plugin)

      platform.metrics().boolean(`datadog.tracer.node.plugin.enabled.by.name`, false, `name:${meta.name}`)
    }
  }

  preload () {
    if (!this._loader.preload) {
      return
    }
    const pluginsMap = new Map()
    Object.keys(plugins)
      .filter(name => !this._plugins.has(plugins[name]))
      .forEach(name => {
        pluginsMap.set(plugins[name], { name, config: getConfig(name) })
      })
    this._loader.preload(pluginsMap)
  }

  prepatch (instrumentation, moduleExports) {
    if (!instrumentation.prepatch) {
      return
    }
    const patches = [].concat(instrumentation.prepatch(moduleExports))
    for (const { object, methods } of patches) {
      for (const name of methods) {
        this.wrap(object, name, getPrepatchWrappedFunction)
        // While we're re-using wrap here for simplicity, we don't want to have
        // the other code here assume that it has been pached in the sense that
        // the _plugin's_ `patch` function has been called. We'ere adding a
        // `_datadog_wrapped` property instead.
        delete object[name]._datadog_patched
      }
    }
  }

  patch (instrumentation, moduleExports, config) {
    let instrumented = this._instrumented.get(instrumentation)

    if (!instrumented) {
      this._instrumented.set(instrumentation, instrumented = new Set())
    }

    if (!instrumented.has(moduleExports)) {
      instrumented.add(moduleExports)
      return instrumentation.patch.call(this, moduleExports, this._tracer._tracer, config)
    }
  }

  unpatch (instrumentation) {
    const instrumented = this._instrumented.get(instrumentation)

    if (instrumented) {
      instrumented.forEach(moduleExports => {
        try {
          instrumentation.unpatch.call(this, moduleExports, this._tracer)
        } catch (e) {
          log.error(e)
        }
      })
    }
  }

  _set (plugin, meta) {
    if (this._disabledPlugins.has(meta.name)) {
      log.debug(`Plugin "${meta.name}" was disabled via configuration option.`)
    } else {
      this._plugins.set(plugin, meta)
      this.load(plugin, meta)
    }
  }
}

module.exports = Instrumenter
