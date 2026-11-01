import { prepareFogharbor } from "../src/games/fogharbor.ts";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || !args[1].trim()) {
  console.error("用法：npm run game:prepare -- --output /绝对路径/尚不存在的游戏目录（父目录需存在）");
  process.exitCode = 1;
} else {
  try {
    const result = prepareFogharbor(args[1]);
    console.log(JSON.stringify(result, null, 2));
    console.log("游戏已准备：使用上面的 configFile 设置 PITAVERN_CONFIG 后 npm start。\n在设置中配置支持原生工具的模型，再打开《雾港最后一盏灯》。未复制密钥或调用模型。");
  } catch (error) {
    console.error("准备失败（不会覆盖已有目录）：" + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
