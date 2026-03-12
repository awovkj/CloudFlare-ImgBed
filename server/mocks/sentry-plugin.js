export default function sentryPlugin() {
    return function(context) {
        if (!context.data) context.data = {};
        context.data.sentry = {
            setTag: () => {},
            setContext: () => {},
            startTransaction: () => ({
                startChild: () => ({ finish: () => {} }),
                finish: () => {}
            })
        };
        return context.next();
    };
}
