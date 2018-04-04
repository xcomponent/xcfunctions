/* jshint esversion: 6 */

const http = require('http');

const nullBodyError = 'Body is null';

const defaultConfig = {
    host: '127.0.0.1',
    port: 9676
};

function setConfig(config) {
    if (!config) {
        return;
    }
    defaultConfig.host = (config.host) ? config.host : defaultConfig.host;
    defaultConfig.port = (config.port) ? config.port : defaultConfig.port;
};

var localStringResources = null;

function getStringResources(callback) {
    const options = {
        host: defaultConfig.host,
        port: defaultConfig.port,
        path: '/api/StringResources',
        method: 'GET'
    };
    http.request(options, function (response) {
        response.on('data', (data) => {
            const jsonData = JSON.parse(data.toString('utf8'));
            if (!jsonData.Message) {
                callback(null, jsonData);
            } else {
                callback(new Error("Error on " + options.host + ":" + options.port), jsonData);
            }
        });
    })
        .on('error', callback)
        .end();
};

function getStringResourceValue(component, key) {
    if (!localStringResources) {
        return undefined;
    }
    const res = localStringResources.filter(e => e.ComponentName == component && e.Key == key);
    if (res.length == 0) {
        return undefined;
    }
    return res[0].Value;
}

exports.getStringResourceValue = getStringResourceValue;

function getTask(componentName, stateMachineName, callback) {
    const getOptions = (componentName, stateMachineName) => {
        return {
            host: defaultConfig.host,
            port: defaultConfig.port,
            path: '/api/Functions?componentName=' + escape(componentName) + '&stateMachineName=' + escape(stateMachineName),
            method: 'GET'
        };
    };

    http
        .request(getOptions(componentName, stateMachineName), function (response) {
            let body = '';
            response.on('data', (data) => {
                body += data;
            });
            response.on('end', () => {
                if (body === 'null') {
                    callback(nullBodyError, null);
                    return;
                }

                try {
                    callback(null, JSON.parse(body));
                } catch (e) {
                    callback(e, null);
                }
            });
            response.on('error', callback);
        })
        .on('error', callback)
        .end();
}

function postObject(object, endpoint, callback) {
    const postOptions = {
        host: defaultConfig.host,
        port: defaultConfig.port,
        path: '/api/' + endpoint,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        }
    };

    const request = http.request(postOptions, function (response) {
        if (response.statusCode != 204) {
            if (callback) callback(response.statusCode);
        } else {
            if (callback) callback(null, response.statusCode);
        }
    });

    request.on('error', function (error) {
        if (callback) callback(error);
    });

    request.write(JSON.stringify(object));
    request.end();
}

function postConfiguration(configurationObject, callback) {
    postObject(configurationObject, 'Configuration', callback);
}

function postResult(responseObject, callback) {
    postObject(responseObject, 'Functions', callback);
}

const triggeredMethods = {};

exports.registerTriggeredMethod = (componentName, stateMachineName, triggeredMethodName, triggeredMethodFunction) => {
    if (!(componentName in triggeredMethods)) {
        triggeredMethods[componentName] = {};
    }
    if (!(stateMachineName in triggeredMethods[componentName])) {
        triggeredMethods[componentName][stateMachineName] = {};
    }

    triggeredMethods[componentName][stateMachineName][triggeredMethodName] = triggeredMethodFunction;
};

exports.registerTriggeredMethods = (componentName, stateMachineName, triggeredMethods) => {
    for (const triggeredMethodName in triggeredMethods) {
        exports.registerTriggeredMethod(componentName, stateMachineName, triggeredMethodName, triggeredMethods[triggeredMethodName]);
    }
}

function updateConfiguration(configuration, callback) {
    if (configuration) {
        const postConfigurationAction = () => postConfiguration(configuration, configurationCallback);
        let configurationTimerID = null;
        const configurationCallback = (error) => {
            if (error) {
                console.error('Error updating configuration: ', error);
                callback(error, null);
                return;
            }
            console.log('Configuraton successfuly updated!');
            callback(null, true);
        };

        postConfigurationAction();
        installEventQueue(callback)
    } else {
        installEventQueue(callback)
    }
}

function installEventQueue(callback) {
    setInterval(eventQueue, 1000);
    console.log('Waiting for tasks...');
    callback(null, true);
}

exports.startEventQueue = (configuration, callback) => {
    setConfig(configuration);
    getStringResources((error, stringResources) => {
        if (error) {
            console.error(error);
            return callback && callback(error, null);
        }
        localStringResources = stringResources;
        updateConfiguration(configuration, (error, success) => callback && callback(error, success));
    });
};

function senderHandler(target, name) {
    return (parameter, useContext) => {
        target.Senders.push({
            SenderName: name,
            SenderParameter: parameter || {},
            UseContext: useContext || false
        });
    };
}

function eventQueue() {
    for (const componentName in triggeredMethods) {
        for (const stateMachineName in triggeredMethods[componentName]) {
            getTask(componentName, stateMachineName, (error, task) => {
                if (error) {
                    if (error !== nullBodyError && !(error.code && error.code === 'ECONNREFUSED')) {
                        console.error(error);
                    }
                    return;
                }

                console.log('Received task: ', task);

                if (!(task.FunctionName in triggeredMethods[componentName][stateMachineName])) {
                    console.error('Received task for unregistered function', task.FunctionName);
                    return;
                }

                const triggeredMethod = triggeredMethods[componentName][stateMachineName][task.FunctionName];
                const sendersList = [];
                const sender = new Proxy({ Senders: sendersList }, { get: senderHandler });

                try {
                    triggeredMethod(task.Event, task.PublicMember, task.InternalMember, task.Context, sender);
                } catch (e) {
                    console.error("Caught exception", e);
                    error = e;
                }

                if (!error) {
                    postResult({
                        // jshint ignore:start
                        Senders: sendersList,
                        PublicMember: task.PublicMember,
                        InternalMember: task.InternalMember,
                        ComponentName: task.ComponentName,
                        StateMachineName: task.StateMachineName,
                        RequestId: task.RequestId
                        // jshint ignore:end
                    });
                } else {
                    postResult({
                        // jshint ignore:start
                        IsError: true,
                        ErrorMessage: "" + error
                        // jshint ignore:end
                    });
                }
            });
        }
    }
}

