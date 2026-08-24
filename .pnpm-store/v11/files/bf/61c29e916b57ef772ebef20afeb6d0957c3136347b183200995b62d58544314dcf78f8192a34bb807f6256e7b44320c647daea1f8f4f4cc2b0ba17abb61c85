import { ISpecificationExtension } from './specification-extension.js';

interface ServerObject extends ISpecificationExtension {
    url: string;
    description?: string;
    variables?: {
        [v: string]: ServerVariableObject;
    };
}
interface ServerVariableObject extends ISpecificationExtension {
    enum?: string[] | boolean[] | number[];
    default: string | boolean | number;
    description?: string;
}

export type { ServerObject, ServerVariableObject };
