require("dotenv").config();
const ethers = require("ethers");
const axios = require("axios");

const mongoose = require("mongoose");
const TrackerState = mongoose.model("TRACKER_STATE");
const EVENT_DEAD_LETTER_QUEUE = require("../models/event_deadletter_queue");
const EventDeadLetterQueue = mongoose.model(
	"EVENT_DEAD_LETTER_QUEUE",
	EVENT_DEAD_LETTER_QUEUE
);

const RaisyCampaignsContractInfo = require("../constants/raisycampaignsabi");
const provider = new ethers.providers.JsonRpcProvider(
	process.env.NETWORK_RPC,
	parseInt(process.env.NETWORK_CHAINID)
);
const decoder = new ethers.utils.AbiCoder();

const loadCampaignsContract = () => {
	const abi = RaisyCampaignsContractInfo.abi;
	const address = process.env.CONTRACTADDRESS;
	return new ethers.Contract(address, abi, provider);
};
const raisyCampaignsSc = loadCampaignsContract();

const apiEndPoint = process.env.API_ENDPOINT;
const callAPI = async (endpoint, data) => {
	try {
		console.log("requesting", apiEndPoint + endpoint);
		const response = await axios({
			method: "post",
			url: apiEndPoint + endpoint,
			data,
		});
		// console.log("response: ", response);
	} catch (err) {
		// If bad request save event-data to dead letter queue
		if (err && err.response && err.response.status === 400) {
			console.warn(
				`[bad-request] add event to dead-letter-queue, txHash: ${data.transactionHash}`
			);
			await EventDeadLetterQueue.create({
				contract: process.env.CONTRACTADDRESS,
				event: data,
			});
			return;
		}
		// If other reasons (server unreachable for example) throw and block;
		throw err;
	}
};

const processCampaignsEvents = async (startFromBlock) => {
	const currentBlock = await provider.getBlockNumber();
	let lastBlockProcessed = startFromBlock;

	console.info(`Tracking block: ${startFromBlock} - ${currentBlock}`);

	const handleNewDonation = async (event) => {
		return callAPI("campaign/newDonation", event);
	};

	const handleNewSchedule = async (event) => {
		return callAPI("schedule/newSchedule", event);
	};

	const handleFundsClaimed = async (event) => {
		return callAPI("schedule/fundsClaimed", event);
	};
	const handleNewVoteSession = async (event) => {
		return callAPI("voteSession/newVoteSession", event);
	};
	const handleNewVote = async (event) => {
		return callAPI("voteSession/newVote", event);
	};
	const handleEndVoteSession = async (event) => {
		return callAPI("voteSession/endVoteSession", event);
	};

	async function handleEvents(events) {
		for (const event of events) {
			// Item lifecycle events
			if (event.event === "NewDonation") {
				console.log(
					`[NewDonation] tx: ${event.transactionHash}, block: ${event.blockNumber}`
				);
				await handleNewDonation(event);
			}

			if (event.event === "ScheduleRegistered") {
				console.log(
					`[ScheduleRegistered] tx: ${event.transactionHash}, block: ${event.blockNumber}`
				);
				await handleNewSchedule(event);
			}

			if (event.event === "FundsClaimed") {
				console.log(
					`[FundsClaimed] tx: ${event.transactionHash}, block: ${event.blockNumber}`
				);
				await handleFundsClaimed(event);
			}

			if (event.event === "VoteSessionInitialized") {
				console.log(
					`[VoteSessionInitialized] tx: ${event.transactionHash}, block: ${event.blockNumber}`
				);
				await handleNewVoteSession(event);
			}

			if (event.event === "NewVote") {
				console.log(
					`[NewVote] tx: ${event.transactionHash}, block: ${event.blockNumber}`
				);
				await handleNewVote(event);
			}

			if (event.event === "EndVoteSession") {
				console.log(
					`[EndVoteSession] tx: ${event.transactionHash}, block: ${event.blockNumber}`
				);
				await handleEndVoteSession(event);
			}

			if (!event.event) {
				const VoteSessionInitializedEvent = "0x45fa97d8";
				const NewVoteEvent = "0x";
				console.log(
					"[UNDEFINED EVENT][isVoteSessionInitialized || isNewVote ?] method: ",
					event.topics[0].slice(0, 10),
					" : ",
					VoteSessionInitializedEvent,
					"||",
					NewVoteEvent
				);
				if (event.topics[0].slice(0, 10) === VoteSessionInitializedEvent) {
					console.log(
						`[VoteSessionInitialized][BACKUP] tx: ${event.transactionHash}, block: ${event.blockNumber}`
					);

					const decodedData = decoder.decode(
						["uint256", "uint256"],
						event.data
					);
					const args = [...decodedData];

					await handleNewVoteSession({
						...event,
						event: "VoteSessionInitialized",
						args,
					});
				} else if (event.topics[0].slice(0, 10) === NewVoteEvent) {
					console.log(
						`[NewVote][BACKUP] tx: ${event.transactionHash}, block: ${event.blockNumber}`
					);

					const decodedData = decoder.decode(
						["uint256", "uint256", "int256"],
						event.data
					);
					const voter = decoder.decode(["address"], event.topics[1])[0];
					const args = [voter, ...decodedData];

					await handleNewVote({ ...event, event: "NewVote", args });
				}
			}

			lastBlockProcessed = event.blockNumber + 1;
		}
	}

	try {
		const pastEvents = await raisyCampaignsSc.queryFilter(
			"*",
			startFromBlock,
			currentBlock
		);
		const batches = pastEvents.reduce((batchArray, item, index) => {
			const chunkIndex = Math.floor(index / 10);

			if (!batchArray[chunkIndex]) {
				batchArray[chunkIndex] = []; // start a new chunk
			}

			batchArray[chunkIndex].push(item);

			return batchArray;
		}, []);

		batches.length && console.log(`Event batches to run ${batches.length}`);
		let runBatch = 0;
		await new Promise((resolve) => {
			let interval = setInterval(async () => {
				if (runBatch >= batches.length) {
					clearInterval(interval);
					return resolve();
				}

				await handleEvents(batches[runBatch]);
				await TrackerState.updateOne(
					{ contractAddress: process.env.CONTRACTADDRESS },
					{ lastBlockProcessed }
				);
				console.log(
					`[PastEvents] Proccesed batch ${runBatch + 1} of ${batches.length}`
				);
				console.log(`[PastEvents] LastBlockProcessed: ${lastBlockProcessed}`);

				runBatch += 1;
			}, 1000);
		});
	} catch (err) {
		console.error(err.message);
	}
};

module.exports = processCampaignsEvents;
