import { Plugin } from 'rollup';
import { FilterPattern } from '@rollup/pluginutils';
import { Options, JsMinifyOptions } from '@swc/core';
export { default as preserveUseDirective } from 'rollup-preserve-directives';

type PluginOptions = {
    include?: FilterPattern;
    exclude?: FilterPattern;
    extensions?: string[] | undefined;
    /**
     * Use given tsconfig file instead
     * Disable it by setting to `false`
     */
    tsconfig?: string | false | undefined;
} & Omit<Options, 'filename' | 'include' | 'exclude'>;
declare function swc(options?: PluginOptions): Plugin;
declare function minify(options?: JsMinifyOptions): Plugin;
declare function viteMinify(options?: JsMinifyOptions): any;
declare function defineRollupSwcOption(option: PluginOptions): PluginOptions;
declare function defineRollupSwcMinifyOption(option: JsMinifyOptions): JsMinifyOptions;

export { type PluginOptions, swc as default, defineRollupSwcMinifyOption, defineRollupSwcOption, minify, swc, viteMinify };
