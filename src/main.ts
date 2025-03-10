import qs from 'querystring'
import path from 'path'
import fs from 'fs'
import type { SFCBlock, SFCDescriptor } from '@vue/component-compiler-utils'
import type { TransformPluginContext } from 'rollup'
import type { RawSourceMap } from 'source-map'
import { SourceMapGenerator } from 'source-map'
import * as Vite from 'vite'
import { createDescriptor } from './utils/descriptorCache'
import { rewriteDefault } from './utils/rewriteDefault'
import { vueComponentNormalizer, vueHotReload } from './index'
import type { ResolvedOptions } from './index'

export async function transformMain(
  code: string,
  filePath: string,
  options: ResolvedOptions,
  pluginContext: TransformPluginContext,
) {
  const descriptor = createDescriptor(code, filePath, options)

  const hasFunctional
    = descriptor.template && descriptor.template.attrs.functional

  // template
  const { code: templateCode, templateRequest } = await genTemplateRequest(
    filePath,
    descriptor,
    pluginContext,
  )
  // script
  const scriptVar = '__vue2_script'
  const { scriptCode, map: scriptMap } = await genScriptCode(
    scriptVar,
    descriptor,
    filePath,
    options,
    pluginContext,
  )
  // style
  const cssModuleVar = '__cssModules'
  const { scoped, stylesCode } = await genStyleRequest(
    cssModuleVar,
    descriptor,
    filePath,
    pluginContext,
  )

  let result
    = `${`${scriptCode}
${templateCode}
const ${cssModuleVar} = {}
${stylesCode}
/* normalize component */
import __vue2_normalizer from "${vueComponentNormalizer}"
var __component__ = /*#__PURE__*/__vue2_normalizer(
  __vue2_script,
  __vue2_render,
  __vue2_staticRenderFns,
  ${hasFunctional ? 'true' : 'false'},
  __vue2_injectStyles,
  ${scoped ? JSON.stringify(descriptor.id) : 'null'},
  null,
  null
)
  `.trim()}\n`

  result += `
function __vue2_injectStyles (context) {
  for(let o in ${cssModuleVar}){
    this[o] = ${cssModuleVar}[o]
  }
}\n`

  // custom block
  result += await genCustomBlockCode(filePath, descriptor, pluginContext)
  // Expose filename. This is used by the devtools and Vue runtime warnings.
  if (!options.isProduction) {
    // Expose the file's full path in development, so that it can be opened
    // from the devtools.
    result += `\n__component__.options.__file = ${JSON.stringify(
      path.relative(options.root, filePath).replace(/\\/g, '/'),
    )}`
  }
  // else if (options.exposeFilename) {
  //   // Libraries can opt-in to expose their components' filenames in production builds.
  //   // For security reasons, only expose the file's basename in production.
  //   code += `\n__component__.options.__file = ${JSON.stringify(filePath)}`
  // }

  if (options.devServer && !options.isProduction) {
    result += genHmrCode(
      options.root,
      descriptor.id,
      !!hasFunctional,
      templateRequest,
    )
  }

  let map = scriptMap
  // if script source map is undefined, generate an emty souce map so that
  // rollup wont complain at build time when using sourceMap option
  if (!map) {
    const emptyMapGen = new SourceMapGenerator({
      file: filePath.replace(/\\/g, '/'),
      sourceRoot: options.root.replace(/\\/g, '/'),
    })
    emptyMapGen.setSourceContent(filePath, code)
    map = JSON.parse(emptyMapGen.toString())
  }

  result += '\nexport default /*#__PURE__*/(function () { return __component__.exports })()'
  return {
    code: result,
    map,
  }
}

const exportDefaultClassRE = /export\s+default\s+class\s+([\w$]+)/

async function genScriptCode(
  scriptVar: string,
  descriptor: SFCDescriptor,
  filename: string,
  options: ResolvedOptions,
  _pluginContext: TransformPluginContext,
): Promise<{
  scriptCode: string
  map?: RawSourceMap
}> {
  const { script } = descriptor
  let scriptCode = `const ${scriptVar} = {}`
  if (!script)
    return { scriptCode }

  let map
  if (script) {
    // If the script is js/ts and has no external src, it can be directly placed
    // in the main module.
    if (
      (!script.lang || (script.lang === 'ts' && options.devServer))
      && !script.src
    ) {
      const classMatch = script.content.match(exportDefaultClassRE)
      if (classMatch) {
        scriptCode = `${script.content.replace(
          exportDefaultClassRE,
          'class $1',
        )}\nconst ${scriptVar} = ${classMatch[1]}`
      }
      else {
        scriptCode = rewriteDefault(script.content, scriptVar)
      }
      map = script.map
      if (script.lang === 'ts') {
        // transformWithEsbuild has been exported since vite@2.6.0-beta.0
        const transformWithEsbuild
          = Vite.transformWithEsbuild ?? options.devServer!.transformWithEsbuild
        const result = await transformWithEsbuild(
          scriptCode,
          filename,
          { loader: 'ts', target: options.target },
          map,
        )
        scriptCode = result.code
        map = result.map
        // restore esbuild missing sourcemap fields from previous compilation
        if (!map.file && script.map?.file)
          map.file = script.map.file

        if (!map.sourcesContent && script.map?.sourcesContent)
          map.sourcesContent = script.map.sourcesContent
      }
    }
    else {
      const src = script.src || filename
      const langFallback = (script.src && path.extname(src).slice(1)) || 'js'
      const attrsQuery = attrsToQuery(script.attrs, langFallback)
      const srcQuery = script.src ? '&src' : ''
      const from = script.src ? `&from=${encodeURIComponent(filename)}` : ''
      const query = `?vue&type=script${srcQuery}${from}${attrsQuery}`
      const request = JSON.stringify(src + query)
      scriptCode
        = `import ${scriptVar} from ${request}\n` + `export * from ${request}` // support named exports
    }
  }
  return {
    scriptCode,
    map: map as any,
  }
}

async function genTemplateRequest(
  filename: string,
  descriptor: SFCDescriptor,
  _pluginContext: TransformPluginContext,
) {
  const template = descriptor.template
  if (!template)
    return { code: 'let __vue2_render, __vue2_staticRenderFns' }

  const src = template.src || filename
  const srcQuery = template.src ? '&src' : ''
  const from = template.src ? `&from=${encodeURIComponent(filename)}` : ''
  const attrsQuery = attrsToQuery(template.attrs, 'js', true)
  const query = `?vue${from}&type=template${srcQuery}${attrsQuery}`
  const templateRequest = src + query
  return {
    code: `import { render as __vue2_render, staticRenderFns as __vue2_staticRenderFns } from ${JSON.stringify(
      templateRequest,
    )}`,
    templateRequest,
  }
}

async function genCustomBlockCode(
  filename: string,
  descriptor: SFCDescriptor,
  _pluginContext: TransformPluginContext,
) {
  let code = ''
  await Promise.all(
    descriptor.customBlocks.map(async(block, index) => {
      const blockSrc
        = typeof block.attrs.src === 'string' ? block.attrs.src : ''
      const src = blockSrc || filename
      const attrsQuery = attrsToQuery(
        block.attrs,
        path.extname(blockSrc) || block.type,
      )
      const srcQuery = block.attrs.src ? '&src' : ''
      const from = block.attrs.src
        ? `&from=${encodeURIComponent(filename)}`
        : ''
      const query = `?vue&type=${block.type}&index=${index}${srcQuery}${from}${attrsQuery}`
      const request = JSON.stringify(src + query)
      code += `import block${index} from ${request}\n`
      code += `if (typeof block${index} === 'function') block${index}(__component__)\n`
    }),
  )
  return code
}

function genHmrCode(
  root: string,
  id: string,
  functional: boolean,
  templateRequest?: string,
) {
  const idJSON = JSON.stringify(id)
  return `\n/* hot reload */
import __VUE_HMR_RUNTIME__ from ${JSON.stringify(vueHotReload)}
import vue from "vue"
__VUE_HMR_RUNTIME__.install(vue)
if(!import.meta.env.SSR && __VUE_HMR_RUNTIME__.compatible){
  if (!__VUE_HMR_RUNTIME__.isRecorded(${idJSON})) {
    __VUE_HMR_RUNTIME__.createRecord(${idJSON}, __component__.options)
  }
   import.meta.hot.accept((update) => {
      __VUE_HMR_RUNTIME__.${
        functional ? 'rerender' : 'reload'
      }(${idJSON}, update.default)
   })
   ${
     templateRequest
       ? `import.meta.hot.accept(${JSON.stringify(
           normalizeDevPath(root, templateRequest),
         )}, (update) => {
      __VUE_HMR_RUNTIME__.rerender(${idJSON}, update)
   })`
       : ''
   }
}`
}

async function genStyleRequest(
  cssModuleVar: string,
  descriptor: SFCDescriptor,
  filename: string,
  _pluginContext: TransformPluginContext,
) {
  let scoped = false
  let stylesCode = ''
  for (let i = 0; i < descriptor.styles.length; i++) {
    const style = descriptor.styles[i]
    const src = style.src || filename
    const attrsQuery = attrsToQuery(style.attrs, 'css')
    const srcQuery = style.src ? '&src' : ''
    const from = style.src ? `&from=${encodeURIComponent(filename)}` : ''
    const query = `?vue&type=style&index=${i}${from}${srcQuery}`
    const styleRequest = src + query + attrsQuery
    if (style.scoped)
      scoped = true
    if (style.module) {
      stylesCode += genCSSModulesCode(
        i,
        styleRequest,
        style.module,
        cssModuleVar,
      )
    }
    else {
      stylesCode += `\nimport ${JSON.stringify(styleRequest)}`
    }
  }

  return { scoped, stylesCode }
}

function genCSSModulesCode(
  index: number,
  request: string,
  moduleName: string | boolean,
  cssModuleVar: string,
): string {
  const styleVar = `__style${index}`
  const exposedName = typeof moduleName === 'string' ? moduleName : '$style'
  // inject `.module` before extension so vite handles it as css module
  const moduleRequest = request.replace(/\.(\w+)$/, '.module.$1')
  return (
    `\nimport ${styleVar} from ${JSON.stringify(moduleRequest)}`
    + `\n${cssModuleVar}["${exposedName}"] = ${styleVar}`
  )
}

// these are built-in query parameters so should be ignored
// if the user happen to add them as attrs
const ignoreList = ['id', 'index', 'src', 'type', 'lang', 'module']

function attrsToQuery(
  attrs: SFCBlock['attrs'],
  langFallback?: string,
  forceLangFallback = false,
): string {
  let query = ''
  for (const name in attrs) {
    const value = attrs[name]
    if (!ignoreList.includes(name)) {
      query += `&${qs.escape(name)}${
        value ? `=${qs.escape(String(value))}` : ''
      }`
    }
  }
  if (langFallback || attrs.lang) {
    query
      += 'lang' in attrs
        ? forceLangFallback
          ? `&lang.${langFallback}`
          : `&lang.${attrs.lang}`
        : `&lang.${langFallback}`
  }
  return query
}

export const FS_PREFIX = '/@fs/'

function normalizeDevPath(root: string, id: string) {
  if (id.startsWith(`${root}/`))
    return id.slice(root.length)
  else if (fs.existsSync(cleanUrl(id)))
    return FS_PREFIX + id

  return id
}

export const queryRE = /\?.*$/
export const hashRE = /#.*$/

export function cleanUrl(url: string) {
  return url.replace(hashRE, '').replace(queryRE, '')
}
