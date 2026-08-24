import { s as serialize } from '../serialize-hqt5osie.mjs';
import { INFINITE_PREFIX } from '../_internal/constants.mjs';

const getFirstPageKey = (getKey)=>{
    return serialize(getKey ? getKey(0, null) : null)[0];
};
const unstable_serialize = (getKey)=>{
    return INFINITE_PREFIX + getFirstPageKey(getKey);
};

export { unstable_serialize };
