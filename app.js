require('dotenv').config()
const express = require("express");
const app = express();

const mongoose = require('mongoose');
require('./models/tracker_state');
require('./models/event_deadletter_queue');

const TRACKER_STATE = require('./models/tracker_state');
const TrackerState = mongoose.model('TRACKER_STATE', TRACKER_STATE);
const processCampaignsEvents = require('./services/raisycampaignstracker')

const cors = require("cors");
const port = process.env.PORT || 5002;

app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Credentials", true);
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin,X-Requested-With,Content-Type,Accept,content-type,application/json"
  );
  next();
});

app.use(cors());
app.options("*", cors());


const connect = () => {
  const uri = process.env.DB_URL
  mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
  const db = mongoose.connection

  db.on('error', console.error.bind(console, 'connection error:'))
  db.once('open', async () => {
    // Check last block processed;
    const result = await TrackerState.find({ contractAddress: process.env.CONTRACTADDRESS });
    if (!result.length) {
      await TrackerState.create({ contractAddress: process.env.CONTRACTADDRESS, lastBlockProcessed: 0 });
    }

    const trackContractCallback = async () => {
      const lastBlockRecord = await TrackerState.find({ contractAddress: process.env.CONTRACTADDRESS });
      await processCampaignsEvents(lastBlockRecord[0].lastBlockProcessed);
      setTimeout(() => trackContractCallback(), 2000);
    }

    app.listen(port, async () => {
      await trackContractCallback();
    })

    // await trackContractCallback();
  })
}

connect();
