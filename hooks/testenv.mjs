// process.env sạch cho child process của test — biến ASK_JEV_*/JEV_*/key của dev không được lọt vào.
export const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ASK_)?JEV_|^(TYPESAFE|AI_GATEWAY)_API_KEY$/.test(k)));
