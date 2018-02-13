const { gdax, websocket, DANGER_LIVE_GDAX_DANGER, DANGER_LIVE_WEBSOCKET_DANGER } = require('./gdax')
const moment = require('moment')

const HistoricDataProvider = require('./HistoricDataProvider')
const BacktestDataProvider = require('./BacktestDataProvider')

const ProgressBar = require('ascii-progress');
const uuid = require('uuid/v1')

// @TODO add slippage
class BacktestBot {
    constructor({
        strategy,
        manager,
        options
    }) {
        this.strategy = strategy
        this.manager = manager
        this.options = options
        this.startMoment = moment(this.options.backtest.start_date)
        this.endMoment = this.options.backtest.end_date ? moment(this.options.backtest.end_date) : moment()
        this.chunkSize = 350
        this.rateLimit = 3
        this.iterations = 0
    }

    /**
     * wait for 1 second to avoid being rate limited by gdax api
     * 
     * @return {Promise}
     */
    async rateLimitResolver() {
        return new Promise(resolve => {
            setTimeout(resolve, 1000);
        })
    }

    /**
     * Let the trading (backtest) begin!
     * Gets historic data for initial analyzing and first series of candles
     * 
     * @return void
     */
    async startTrading() {
        console.log(`>> Backtesting ${this.options.product} with ${this.options.granularity} seconds with ${this.options.strategy} strategy from ${this.options.backtest.start_date} to ${this.options.backtest.end_date || moment().toISOString()}.\n`)
        this.progress = new ProgressBar({
            schema: ':bar.green :percent',
            total: this.endMoment.diff(this.startMoment, 'seconds') / this.options.granularity,
            clear: true
        });
        let preData = await this.getDataChunk(null, this.startMoment)
        HistoricDataProvider.connect(preData)
        let endChunkDate = moment(this.startMoment).add(this.chunkSize * this.options.granularity, 'seconds')
        let firstChunk = await this.getDataChunk(this.startMoment, endChunkDate)
        BacktestDataProvider.append(firstChunk)

        this.trade()
    }

    /**
     * Get Data Chunk
     * 
     * @return Promise
     */
    async getDataChunk(start, end) {
        if (this.iterations == this.rateLimit) {
            await this.rateLimitResolver()
            this.iterations = 0
        }
        this.iterations++
        let chunk = gdax.getProductHistoricRates(this.options.product, {
            granularity: this.options.granularity,
            start: start ? start.toISOString() : null,
            end: end ? end.toISOString() : null
        }).catch(err => { throw new Error(err) })

        if (chunk.message) {
            throw new Error(chunk.message)
        }

        return chunk
    }

    /**
     * Execute a strategy with a historical dataset
     * Chunks data fetching and analyzations to avoid 
     * stackoverflows and speed up backtesting
     * 
     * @return void
     */
    async trade() {
        HistoricDataProvider.append(BacktestDataProvider.current())
        let signal = this.strategy.signal()

        if (this.manager.shouldTriggerStop(BacktestDataProvider.current()[4])) {
            this.shortPosition()
        } else if (signal == 'LONG') {
            this.longPosition()
        } else if (signal == 'SHORT') {
            this.shortPosition()
        }

        if (BacktestDataProvider.next()) {
            this.progress.tick()
            this.trade()
            return
        } else {
            let lastTick = moment(BacktestDataProvider.previous()[0] * 1000)
            let nextTick = moment(lastTick).add(this.options.granularity, 'seconds')
            let nextTickDiff = this.endMoment.diff(nextTick, 'seconds')
            if (nextTickDiff <= 0) {
                this.stopTrading()
                return
            }
            let nextChunkSize = Math.min(nextTickDiff, this.options.granularity * this.chunkSize)
            let nextChunkEnd = moment(nextTick).add(nextChunkSize, 'seconds')
            let chunk = await this.getDataChunk(
                nextTick,
                nextChunkEnd
            )
            BacktestDataProvider.append(chunk)
            BacktestDataProvider.next()
            this.trade()
        }   
    }

    /**
     * open a position, update, fill
     * 
     * @return void
     */
    longPosition() {
        if (this.manager.getPosition()) {
            return
        }

        // kind of makes a best-case scenario assumption here (not ideal)
        let best_bid = BacktestDataProvider.current()[4]
        let params = {
            order_id: uuid(),
            side: 'buy',
            size: this.manager.getOrderSize(best_bid),
            price: best_bid,
            remaining_size: 0,
            reason: 'filled'
        }

        // mock the feed
        this.openHandler(params)
        this.matchHandler(params)
        this.doneHandler(params)
    }

    /**
     * close a position, update, fill
     * 
     * @return void
     */
    shortPosition() {
        let position = this.manager.getPosition()
        if (!position) {
            return
        }
        
        // kind of makes a best-case scenario assumption here
        let best_ask = BacktestDataProvider.current()[4]
        let params = {
            order_id: uuid(),
            side: 'sell',
            size: position.size,
            price: best_ask,
            remaining_size: 0,
            reason: 'filled'
        }

        // mock the feed
        this.openHandler(params)
        this.matchHandler(params)
        this.doneHandler(params)
    }

    /**
     * Stop the test and log the results
     * 
     * @return void
     */
    stopTrading() {
        this.progress.clear()
        // end on a sell so we can see more reliable percentage
        if (this.manager.getPosition()) {
            BacktestDataProvider.previous()
            this.shortPosition()
        }
        console.log('>> Backtest complete.\n')
        console.log(this.manager.info())
        console.log('\n')
        process.exit()
    }

    /**
     * Order open on book
     * The order is now open on the order book. This message will only be sent for orders which are not fully filled immediately.remaining_size will indicate how much of the order is unfilled and going on the book.
     * 
     * @param {*} data 
     */
    openHandler(data) {
        this.manager.addOpen(data)
    }

    /**
     * When a trade is matched(exchanged)
     */
    matchHandler(data) {

        if (this.manager.getPosition()) {
            this.manager.updatePosition(data)
        } else {
            this.manager.openPosition(data)
        }

        // remove a specific order by id
        data.maker_order_id = data.order_id
        this.manager.removeOpen(data.maker_order_id)
        this.manager.addFilled(data)
    }

    /**
     * Order has been completed from the books
     * Sent for all orders for which there was a received message
     * 
     * @param {*} data 
     */
    doneHandler(data) {
        let remainingSize = parseFloat(data.remaining_size)
        if (
            (data.reason == 'canceled' && data.side == 'sell') ||
            (data.reason == 'filled' && data.side == 'sell' && remainingSize !== 0)
        ) {
            this.placeOrder({
                side: data.side,
                size: remainingSize,
                price: BacktestDataProvider.state().best_ask, //for now only sells open new orders
                post_only: true,
                time_in_force: 'GTT',
                cancel_after: 'min'
            })
        }
    }
}
module.exports = BacktestBot