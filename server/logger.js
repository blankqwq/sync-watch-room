export function createLogger(nodeEnv = "development") {
  function write(level, message, context = {}) {
    const entry = { time: new Date().toISOString(), level, message, ...context };
    if (nodeEnv === "production") {
      console.log(JSON.stringify(entry));
      return;
    }
    const details = Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
    console.log(`[${entry.time}] ${level.toUpperCase()} ${message}${details}`);
  }

  return {
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
