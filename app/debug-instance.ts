export default (...args: unknown[]) => {
    if (process.env.DEBUG?.includes('robot.ti.jsnode')) {
        console.debug('[robot.ti.jsnode]', ...args);
    }
};
