// Centralized logging with a configurable verbosity level.

const enum LogLevel {
    Verbose = 1,
    Debug = 2,
    Info = 3,
    Warning = 4,
    Error = 5,
    None = 6,
}

let level: LogLevel = LogLevel.None;

export function setLogLevel(newLevel: string) {
    switch (newLevel.toLowerCase()) {
        case "verbose": level = LogLevel.Verbose; break;
        case "debug": level = LogLevel.Debug; break;
        case "info": level = LogLevel.Info; break;
        case "warning": level = LogLevel.Warning; break;
        case "error": level = LogLevel.Error; break;
        default: level = LogLevel.None;
    }
    console.log("FilePicker: set log level to " + newLevel);
}

export function logv(message: string) {
    if (LogLevel.Verbose >= level) {
        console.log("FilePicker: " + message);
    }
}

export function logd(message: string) {
    if (LogLevel.Debug >= level) {
        console.log("FilePicker: " + message);
    }
}

/** Debug level, accepts any value (used to be the generic logger). */
export function log(message: any) {
    if (LogLevel.Debug >= level) {
        console.log("FilePicker: " + message);
    }
}

export function logi(message: string) {
    if (LogLevel.Info >= level) {
        console.log("FilePicker: " + message);
    }
}

export function logw(message: string) {
    if (LogLevel.Warning >= level) {
        console.warn("FilePicker: " + message);
    }
}

export function loge(message: string) {
    if (LogLevel.Error >= level) {
        console.error("FilePicker: " + message);
    }
}
