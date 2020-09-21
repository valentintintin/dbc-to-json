const _              = require("underscore")
const debug          = require("debug")("transmutator")
const { snakeCase }  = require("snake-case")

const { splitCanId, extractSignalData, extractValueData } = require("./utils")

// TODO: remove empty lines without losing link to line number
const parseDbc = (dbcString) => {
	debug(`The raw dbcString:\n`, dbcString)

	// Split .dbc file per line, make sure index of this array corresponds to line number in file
	let dbcArray = dbcString.split("\n")

	debug(`dbcArray:\n`, dbcArray)

	// Turn every element in dbcArray into an array that's matched on whitespaces
	// This means we get a 2D array; dbcData is an array of every line in the .dbc file
	// Each entry in this array is an array containing every parameter of one .dbc line
	// The 2D array dbcData will look like this:
	// [
	// 	[ "BO_", "123", "Message:", "8", "Vector__XXX" ],
	// 	[ "SG_", "Signal", ":", "0|8@1+", "(1,0)", "[0,255]", "", "Vector__XXX" ]
	// ]
	// See https://regex101.com/r/KDmDI8/8 for a visual example
	let dbcData = _.map(dbcArray, (line, index) => {
		return line.match(/"(?:[^"\\]|\\.)*"|[^\s]+/g)
	})

	debug(`dbcData:\n`, dbcData)

	let currentBo  = {}
	const boList   = []
	const valList  = []
	// Issues can have three severities:
	// info    = this won't cause any major problems and will only affect the message/parameter on the current line
	// warning = this will cause major problems, but only for the message/parameter on the current line
	// error   = this will cause major problems for multiple messages/parameters in both the current line and lines below
	const problems = []
	// TODO change some throws into warnings (and remove lineInDbc from BO_)
	// const warnings = {}

	// Read each line of the parsed .dbc file and run helper functions when the line starts with "BO_, SG_ or VAL_"
	_.each(dbcData, (line, index) => {
		if(!line || line.length === 1)
			return

		switch(line[0]) {
			case("BO_"): // BO_ 2147486648 Edgy: 8 Vector__XXX
				if(line.length !== 5) {
					// throw new Error(`Non-standard BO_ line can't be parsed in the DBC file on line ${index + 1}`)
					problems.push({severity: "error", line: index + 1, description: "BO_ line does not follow DBC standard (should have five pieces of text/numbers), all parameters in this message won't have a PGN or source."})
				}

				// Push previous BO and reset currentBo if not first one
				if(!_.isEmpty(currentBo)) {
					if(_.isEmpty(currentBo.signals)) {
						// throw new Error(`BO_ doesn't contain any parameters in the DBC file on line ${currentBo.lineInDbc}`)
						problems.push({severity: "info", line: index + 1, description: "BO_ does not contain any SG_ lines; message does not have any parameters."})
					}
					boList.push(currentBo)
					currentBo = {}
				}

				// Get data fields
				let [, canId, name, dlc] = line

				if(isNaN(canId)) {
					// throw new Error(`CAN ID is not a number in the DBC file on line ${index + 1}`)
					problems.push({severity: "error", line: index + 1, description: "BO_ CAN ID is not a number, all parameters in this message won't have a PGN or source."})
				}
				name  = name.slice(0, -1)
				canId = parseInt(canId)
				dlc   = parseInt(dlc)

				const duplicateCanId = _.find(boList, { canId })

				if(duplicateCanId) {
					// throw new Error(`Please deduplicate second instance of CAN ID \"${canId}\" in the DBC file on line ${index + 1}`)
					problems.push({severity: "warning", line: index + 1, description: "BO_ CAN ID already exists in this file. Nothing will break on our side, but the data will be wrong because the exact same CAN data will be used on two different parameters."})
				}

				// Split CAN ID into PGN, source and priority (if isExtendedFrame)
				try {
					let { isExtendedFrame, priority, pgn, source } = splitCanId(canId)

					// Add all data fields
					currentBo = {
						canId,
						pgn,
						source,
						name,
						priority,
						isExtendedFrame,
						dlc,
						signals: [],
						lineInDbc: (index + 1),
						label: snakeCase(name)
					}
				} catch (e) {
					// throw new Error(`CAN ID \"${canId}\" is not a number at line ${index + 1}`)
					problems.push({severity: "error", line: index + 1, description: "BO_ CAN ID is not a number, all parameters in this message won't have a PGN or source."})
				}

				break

			case("SG_"): // SG_ soc m0 : 8|8@1+ (0.5,0) [0|100] "%" Vector__XXX
				if(line.length < 8 || line.length > 9) {
					// throw new Error(`Non-standard SG_ line can't be parsed at line ${index + 1}`)
					problems.push({severity: "error", line: index + 1, description: "SG_ line does not follow DBC standard; should have eight pieces of text/numbers (or nine for multiplexed parameters)."})
				}

				try{
					currentBo.signals.push(extractSignalData(line, currentBo.label))
				} catch (e) {
					// throw new Error(`${e.message} in the DBC file on line ${index + 1}`)
					problems.push({severity: "warning", line: index + 1, description: "Can't parse multiplexer data from SG_ line, there should either be \" M \" or \" m0 \" where 0 can be any number."})
				}

				break

			case("VAL_"):
				if(line.length % 2 !== 0) {
					// throw new Error(`Non-standard VAL_ line can't be parsed at line ${index + 1}`)
					problems.push({severity: "warning", line: index + 1, description: "VAL_ line does not follow DBC standard; amount of text/numbers in the line should be an even number. States/values will be incorrect."})
				}

				if(line.length < 7) {
					// throw new Error(`VAL_ line only contains one state at line ${index + 1}`) // Should be a warning
					problems.push({severity: "info", line: index + 1, description: "VAL_ line only contains one state, nothing will break but it defeats the purpose of having states/values for this parameter.does not follow DBC standard; amount of text/numbers in the line should be an even number."})
				}

				let { boLink, sgLink, states } = extractValueData(line)

				valList.push({ boLink, sgLink, states, lineInDbc: (index + 1) })

				break

			case("SIG_VALTYPE_"): // SIG_VALTYPE_ 1024 DoubleSignal0 : 2;
				// TODO implement reading Floats/Doubles directly from CAN
				break

			default:
				debug(`Skipping non implementation line that starts with ${line}`, line)
		}
	})

	if(!_.isEmpty(currentBo))
		boList.push(currentBo)

	if(!boList.length)
		throw new Error(`Invalid DBC: Could not find any BO_ or SG_ lines`)

	// Add VAL_ list to correct SG_
	valList.forEach((val) => {
		let bo = _.find(boList, {canId: val.boLink})
		if(!bo) {
			// throw new Error(`Can't find matching BO_ with CAN ID ${val.boLink} for VAL_ in the DBC file on line ${val.lineInDbc}`)
			problems.push({severity: "info", line: index + 1, description: "VAL_ line could not be matched to BO_ because CAN ID ${val.boLink} can not be found in any message. Nothing will break, and if we add the correct values/states later there won't even be any data loss."})
		}
		let sg = _.find(bo.signals, {name: val.sgLink})
		if(!sg) {
			// throw new Error(`Can't find matching SG_ with name ${val.sgLink} for VAL_ in the DBC file on line ${val.lineInDbc}`)
			problems.push({severity: "info", line: index + 1, description: "VAL_ line could not be matched to SG_ because there's no parameter with the name ${val.sgLink} in the DBC file. Nothing will break, but the customer might intend to add another parameter to the DBC file, so they might complain that it's missing."})
		}
		sg.states = val.states
	})

	// TODO Go over all signals, do the typeOfUnit (deg C -> temperature)

	debug(JSON.stringify(boList, null, 4))
	console.log("Problems\n", problems)
	return boList
}

module.exports = parseDbc
