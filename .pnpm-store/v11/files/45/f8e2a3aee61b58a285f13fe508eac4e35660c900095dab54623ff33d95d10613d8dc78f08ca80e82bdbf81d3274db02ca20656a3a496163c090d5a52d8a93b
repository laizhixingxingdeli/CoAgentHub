import { s as serialize } from './serialize-hqt5osie.mjs';

const preload = (key_, fetcher)=>{
    const [key, fnArg] = serialize(key_);
    return {
        [key]: fetcher(fnArg)
    };
};

export { preload as p };
