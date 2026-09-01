import { parseDecimal, shiftedBy, toFixed } from './bigint';

type NanoUnit = 'RAW' | 'NANO' | 'MRAI' | 'KRAI' | 'RAI';

interface ConvertOptions {
	/** Trim trailing zeros from the result (default: false) */
	trim?: boolean;
}

export default class NanoConverter {
	/**
	 * Converts the input value to the wanted unit
	 *
	 * @param input {string | number} value
	 * @param inputUnit {NanoUnit} the unit to convert from
	 * @param outputUnit {NanoUnit} the unit to convert to
	 * @param options {ConvertOptions} optional settings
	 */
	static convert = (
		input: string | number,
		inputUnit: NanoUnit,
		outputUnit: NanoUnit,
		options: ConvertOptions = {},
	): string => {
		if (input === undefined || input === null || input === '') {
			return '0';
		}
		const { trim = false } = options;
		let value = parseDecimal(input.toString());

		// Convert input to RAW (base unit)
		switch (inputUnit) {
			case 'RAW':
				// Already in RAW
				break;
			case 'NANO':
			case 'MRAI':
				value = shiftedBy(value, 30);
				break;
			case 'KRAI':
				value = shiftedBy(value, 27);
				break;
			case 'RAI':
				value = shiftedBy(value, 24);
				break;
			default:
				throw new Error(
					`Unknown input unit ${inputUnit}, expected one of the following: RAW, NANO, MRAI, KRAI, RAI`,
				);
		}

		// Convert RAW to output unit
		switch (outputUnit) {
			case 'RAW':
				return toFixed(value, 0, trim);
			case 'NANO':
			case 'MRAI':
				return toFixed(shiftedBy(value, -30), 30, trim);
			case 'KRAI':
				return toFixed(shiftedBy(value, -27), 27, trim);
			case 'RAI':
				return toFixed(shiftedBy(value, -24), 24, trim);
			default:
				throw new Error(
					`Unknown output unit ${outputUnit}, expected one of the following: RAW, NANO, MRAI, KRAI, RAI`,
				);
		}
	};
}
