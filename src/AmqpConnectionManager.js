import { EventEmitter } from 'events';
import amqp from 'amqplib';
import urlUtils from 'url';

import ChannelWrapper from './ChannelWrapper';
import { wait } from './helpers';
import pb from 'promise-breaker';
import winston from 'winston';

// Default heartbeat time.
const HEARTBEAT_IN_SECONDS = 5;

/* istanbul ignore next */
function neverThrows() {
    return err =>
        setImmediate(() => {
            throw new Error(`AmqpConnectionManager - should never get here: ${err.message}\n` +
                err.stack);
        });
}

//
// Events:
// * `connect({connection, url})` - Emitted whenever we connect to a broker.
// * `disconnect({err})` - Emitted whenever we disconnect from a broker.
//
export default class AmqpConnectionManager extends EventEmitter {
    /**
     *  Create a new AmqplibConnectionManager.
     *
     * @param {(string|Object)[]} urls - An array of brokers to connect to.
     *   Takes url strings or objects {url: string, connectionOptions?: object}
     *   If present, a broker's [connectionOptions] will be used instead
     *   of [options.connectionOptions] when passed to the amqplib connect method.
     *   AmqplibConnectionManager will round-robin between them whenever it
     *   needs to create a new connection.
     * @param {Object} [options={}] -
     * @param {number} [options.heartbeatIntervalInSeconds=5] - The interval,
     *   in seconds, to send heartbeats.
     * @param {number} [options.reconnectTimeInSeconds] - The time to wait
     *   before trying to reconnect.  If not specified, defaults to
     *   `heartbeatIntervalInSeconds`.
     * @param {Object} [options.connectionOptions] - Passed to the amqplib
     *   connect method.
     * @param {function} [options.findServers] - A `fn(callback)` or a `fn()`
     *   which returns a Promise.  This should resolve to one or more servers
     *   to connect to, either a single URL or an array of URLs.  This is handy
     *   when you're using a service discovery mechanism such as Consul or etcd.
     *   Note that if this is supplied, then `urls` is ignored.
     */
    constructor(urls, options = {}) {
        super();
        if(!urls && !options.findServers) {
            throw new Error("Must supply either `urls` or `findServers`");
        }
        this._channels = [];

        this._currentUrl = 0;
        this.connectionOptions = options.connectionOptions;

        this.heartbeatIntervalInSeconds = options.heartbeatIntervalInSeconds || HEARTBEAT_IN_SECONDS;
        this.reconnectTimeInSeconds = options.reconnectTimeInSeconds || this.heartbeatIntervalInSeconds;

        // There will be one listener per channel, and there could be a lot of channels, so disable warnings from node.
        this.setMaxListeners(0);

        this._findServers = options.findServers || (() => Promise.resolve(urls));

        this._connect();
    }

    // `options` here are any options that can be passed to ChannelWrapper.
    createChannel(options = {}) {
        const channel = new ChannelWrapper(this, options);
        this._channels.push(channel);
        channel.once('close', () => {
            this._channels = this._channels.filter(c => c !== channel);
        });
        return channel;
    }

    close() {
        if(this._closed) { return Promise.resolve(); }
        this._closed = true;

        return Promise.all(this._channels.map(channel => channel.close()))
            .catch(function() {
                // Ignore errors closing channels.
            })
            .then(() => {
                this._channels = [];
                if(this._currentConnection) {
                    this._currentConnection.removeAllListeners('close');
                    this._currentConnection.close();
                }
                this._currentConnection = null;
            });
    }

    isConnected() {
        return !!this._currentConnection;
    }

    _connect() {
        if(this._closed || this._connecting || this.isConnected()) {
            return Promise.resolve();
        }

        this._connecting = true;

        return Promise.resolve()
        .then(() => {
            if(!this._urls || (this._currentUrl >= this._urls.length)) {
                this._currentUrl = 0;
                return pb.callFn(this._findServers, 0, null);
            } else {
                return this._urls;
            }
        })
        .then(urls => {
            if(urls && !Array.isArray(urls)) { urls = [urls]; }
            this._urls = urls;

            if(!urls || (urls.length === 0)) {
                throw new Error('amqp-connection-manager: No servers found');
            }

            // Round robin between brokers
            const url = urls[this._currentUrl];
            this._currentUrl++;

            // url can be a string or object {url: string, connectionOptions?: object}
            const urlString = url.url || url;
            const connectionOptions = url.connectionOptions || this.connectionOptions;

            const amqpUrl = urlUtils.parse(urlString);
            /* if(amqpUrl.search) {
                amqpUrl.search += `&heartbeat=${this.heartbeatIntervalInSeconds}`;
            } else {
                amqpUrl.search = `?heartbeat=${this.heartbeatIntervalInSeconds}`;
            } */
            const realUrlString = urlUtils.format(amqpUrl);
            winston.error(realUrlString);
            winston.error(JSON.stringify(connectionOptions));
            return amqp.connect(realUrlString, connectionOptions)
            .then(connection => {
                this._currentConnection = connection;

                //emit 'blocked' when RabbitMQ server decides to block the connection (resources running low)
                connection.on('blocked', reason => this.emit('blocked', { reason }));

                connection.on('unblocked', () => this.emit('unblocked'));

                connection.on('error', (/* err */) => {
                    // if this event was emitted, then the connection was already closed,
                    // so no need to call #close here
                    // also, 'close' is emitted after 'error',
                    // so no need for work already done in 'close' handler
                });

                // Reconnect if the connection closes
                connection.on('close', err => {
                    this._currentConnection = null;
                    this.emit('disconnect', { err });

                    wait(this.reconnectTimeInSeconds * 1000)
                    .then(() => this._connect())
                    // `_connect()` should never throw.
                    .catch(neverThrows);
                });

                this._connecting = false;
                this.emit('connect', { connection, url: urlString });

                return null;
            });
        })
        .catch(err => {
            const amqpURL = urlUtils.parse(this._urls[0]);
            const formattedURL = urlUtils.format(amqpURL);
            const ops = this.connectionOptions;
            this.emit('disconnect', { amqpURL, formattedURL, ops, err });

            // Connection failed...
            this._currentConnection = null;

            // TODO: Probably want to try right away here, especially if there are multiple brokers to try...
            return wait(this.reconnectTimeInSeconds * 1000)
            .then(() => {
                this._connecting = false;
                return this._connect();
            });
        });
    }
}
