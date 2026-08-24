import { Plugin } from 'rollup';

interface PreserveDirectiveMeta {
    shebangs: Map<string, string>;
    directives: Record<string, Set<string>>;
}
declare function preserveDirectives(): Plugin;

declare const preserveDirective: typeof preserveDirectives;

export { type PreserveDirectiveMeta, preserveDirectives as default, preserveDirective };
