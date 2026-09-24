// process.env sạch cho child process của test — biến ASK_JEV_*/JEV_*/key của dev không được lọt vào.
// PASEO_* cũng bị strip (hook tự stand down dưới Paseo); test Paseo opt-in qua extraEnv.
export const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ASK_)?JEV_|^(TYPESAFE|AI_GATEWAY)_API_KEY$|^PASEO_/.test(k)));
