const { getOptions } = require('loader-utils')
const postcss = require('postcss')
const postcssrc = require('postcss-load-config')
const parsePostcssLoaderOptions = require('postcss-loader/src/options')
const postcssPresetEnv = require('postcss-preset-env')
const path = require('path')
const { findNextLoader, isLoader, exec } = require('./utils')
const error = require('./errors')

const rawLoader = require.resolve('raw-loader')

module.exports = async function(content, sourceMap, meta) {
  const callback = this.async()
  const loaderOptions = getOptions(this) || { stage: 0 }

  if (findNextLoader(this, 'css-loader') == null) {
    return callback(error.addBeforeCssLoader)
  }

  const postcssLoaderIndex = this.loaders.findIndex(loader =>
    isLoader(loader, 'postcss-loader')
  )
  if (postcssLoaderIndex === -1) {
    return callback(error.missingPostcssLoader)
  }

  const additionalLoaders = this.loaders.slice(postcssLoaderIndex + 1)
  const additionalLoadersRequest = [
    rawLoader,
    ...additionalLoaders.map(({ request }) => request),
  ].join('!')
  const request =
    additionalLoadersRequest.length > 0
      ? `!!${additionalLoadersRequest}!${this.resource}`
      : `!!${this.resource}`

  let css
  try {
    css = await new Promise((resolve, reject) => {
      this.loadModule(request, (err, sourceBeforePostcss) => {
        if (err) return reject(err)
        resolve(exec(sourceBeforePostcss, this.resourcePath, this.context))
      })
    })
  } catch (err) {
    return callback(err)
  }

  const postcssLoader = this.loaders[postcssLoaderIndex]
  let postcssPlugins
  let postcssOptions

  // imitating postcss-loader behavior
  // https://github.com/postcss/postcss-loader/blob/master/src/index.js

  if (
    Object.keys(postcssLoader.options || {}).filter(
      option => !['ident', 'config', 'sourceMap'].includes(option)
    ).length > 0
  ) {
    const { options, plugins } = await parsePostcssLoaderOptions.call(
      this,
      postcssLoader.options
    )
    postcssOptions = options
    postcssPlugins = plugins
  } else {
    const file = this.resourcePath
    const rc = {
      path: path.dirname(file),
      ctx: {
        cwd: this.context,
        file: {
          extname: path.extname(file),
          dirname: path.dirname(file),
          basename: path.basename(file),
        },
        options: {},
        webpack: this,
      },
    }

    if (postcssLoader.options != null) {
      const { config = {} } = postcssLoader.options
      if (config.path != null) {
        rc.path = path.resolve(config.path)
      }
      if (config.ctx != null) {
        rc.ctx.options = config.ctx
      }
    }

    try {
      const { plugins, options } = await postcssrc(rc.ctx, rc.path)
      postcssPlugins = plugins
      postcssOptions = options
    } catch (err) {
      return callback(err)
    }
  }

  ;['parser', 'syntax', 'stringifier'].forEach(option => {
    if (typeof postcssOptions[option] === 'string') {
      postcssOptions[option] = require(option)
    }
  })

  postcssPlugins = postcssPlugins.map(plugin =>
    plugin.postcssPlugin == null ? plugin() : plugin
  )

  const postcssPresetEnvIndex = postcssPlugins.findIndex(
    ({ postcssPlugin }) => postcssPlugin === 'postcss-preset-env'
  )
  if (postcssPresetEnvIndex === -1) {
    return callback(error.missingPostcssPresetEnv)
  }
  const previousPostcssPlugins = postcssPlugins.slice(0, postcssPresetEnvIndex)

  let extractedCustoms

  try {
    await postcss([
      ...previousPostcssPlugins,
      postcssPresetEnv({
        ...loaderOptions,
        exportTo: customs => {
          extractedCustoms = customs
        },
      }),
    ]).process(css, {
      ...postcssOptions,
      from: this.resourcePath,
      to: undefined,
    })

    const exportContent = [
      `exports.locals = exports.locals || {};`,
      ...Object.entries(extractedCustoms).map(
        ([customsKey, customsMap]) =>
          `exports.locals[${JSON.stringify(customsKey)}] = ${JSON.stringify(
            customsMap,
            null,
            2
          )};`
      ),
    ].join('\n')

    const newContent = `${content.trim()}\n\n${exportContent}`

    callback(null, newContent, sourceMap, meta)
  } catch (err) {
    callback(err)
  }
}