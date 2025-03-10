const exposes = require('../lib/exposes');
const fz = {...require('../converters/fromZigbee'), legacy: require('../lib/legacy').fromZigbee};
const tz = require('../converters/toZigbee');
const ota = require('../lib/ota');
const tuya = require('../lib/tuya');
const reporting = require('../lib/reporting');
const extend = require('../lib/extend');
const e = exposes.presets;
const ea = exposes.access;
const libColor = require('../lib/color');
const utils = require('../lib/utils');
const zosung = require('../lib/zosung');
const fzZosung = zosung.fzZosung;
const tzZosung = zosung.tzZosung;
const ez = zosung.presetsZosung;
const globalStore = require('../lib/store');
const {ColorMode, colorModeLookup} = require('../lib/constants');

const tzLocal = {
    led_control: {
        key: ['brightness', 'color', 'color_temp', 'transition'],
        options: [exposes.options.color_sync()],
        convertSet: async (entity, _key, _value, meta) => {
            const newState = {};

            // The color mode encodes whether the light is using its white LEDs or its color LEDs
            let colorMode = meta.state.color_mode ?? colorModeLookup[ColorMode.ColorTemp];

            // Color mode switching is done by setting color temperature (switch to white LEDs) or setting color (switch
            // to color LEDs)
            if ('color_temp' in meta.message) colorMode = colorModeLookup[ColorMode.ColorTemp];
            if ('color' in meta.message) colorMode = colorModeLookup[ColorMode.HS];

            if (colorMode != meta.state.color_mode) {
                newState.color_mode = colorMode;

                // To switch between white mode and color mode, we have to send a special command:
                const rgbMode = (colorMode == colorModeLookup[ColorMode.HS]);
                await entity.command('lightingColorCtrl', 'tuyaRgbMode', {enable: rgbMode}, {}, {disableDefaultResponse: true});
            }

            // A transition time of 0 would be treated as about 1 second, probably some kind of fallback/default
            // transition time, so for "no transition" we use 1 (tenth of a second).
            const transtime = 'transition' in meta.message ? meta.message.transition * 10 : 1;

            if (colorMode == colorModeLookup[ColorMode.ColorTemp]) {
                if ('brightness' in meta.message) {
                    const zclData = {level: Number(meta.message.brightness), transtime};
                    await entity.command('genLevelCtrl', 'moveToLevel', zclData, utils.getOptions(meta.mapped, entity));
                    newState.brightness = meta.message.brightness;
                }

                if ('color_temp' in meta.message) {
                    const zclData = {colortemp: meta.message.color_temp, transtime: transtime};
                    await entity.command('lightingColorCtrl', 'moveToColorTemp', zclData, utils.getOptions(meta.mapped, entity));
                    newState.color_temp = meta.message.color_temp;
                }
            } else if (colorMode == colorModeLookup[ColorMode.HS]) {
                if ('brightness' in meta.message || 'color' in meta.message) {
                    // We ignore the brightness of the color and instead use the overall brightness setting of the lamp
                    // for the brightness because I think that's the expected behavior and also because the color
                    // conversion below always returns 100 as brightness ("value") even for very dark colors, except
                    // when the color is completely black/zero.

                    // Load current state or defaults
                    const newSettings = {
                        brightness: meta.state.brightness ?? 254, //      full brightness
                        hue: (meta.state.color ?? {}).hue ?? 0, //          red
                        saturation: (meta.state.color ?? {}).saturation ?? 100, // full saturation
                    };

                    // Apply changes
                    if ('brightness' in meta.message) {
                        newSettings.brightness = meta.message.brightness;
                        newState.brightness = meta.message.brightness;
                    }
                    if ('color' in meta.message) {
                        // The Z2M UI sends `{ hex:'#xxxxxx' }`.
                        // Home Assistant sends `{ h: xxx, s: xxx }`.
                        // We convert the former into the latter.
                        const c = libColor.Color.fromConverterArg(meta.message.color);
                        if (c.isRGB()) {
                            // https://github.com/Koenkk/zigbee2mqtt/issues/13421#issuecomment-1426044963
                            c.hsv = c.rgb.gammaCorrected().toXY().toHSV();
                        }
                        const color = c.hsv;

                        newSettings.hue = color.hue;
                        newSettings.saturation = color.saturation;

                        newState.color = {
                            hue: color.hue,
                            saturation: color.saturation,
                        };
                    }

                    // Convert to device specific format and send
                    const zclData = {
                        brightness: utils.mapNumberRange(newSettings.brightness, 0, 254, 0, 1000),
                        hue: newSettings.hue,
                        saturation: utils.mapNumberRange(newSettings.saturation, 0, 100, 0, 1000),
                    };
                    // This command doesn't support a transition time
                    await entity.command('lightingColorCtrl', 'tuyaMoveToHueAndSaturationBrightness2', zclData,
                        utils.getOptions(meta.mapped, entity));
                }
            }

            // If we're in white mode, calculate a matching display color for the set color temperature. This also kind
            // of works in the other direction.
            Object.assign(newState, libColor.syncColorState(newState, meta.state, entity, meta.options, meta.logger));

            return {state: newState};
        },
        convertGet: async (entity, key, meta) => {
            await entity.read('lightingColorCtrl', ['currentHue', 'currentSaturation', 'currentLevel', 'tuyaRgbMode', 'colorTemperature']);
        },
    },
    TS110E_options: {
        key: ['min_brightness', 'max_brightness', 'light_type', 'switch_type'],
        convertSet: async (entity, key, value, meta) => {
            let payload = null;
            if (key === 'min_brightness' || key == 'max_brightness') {
                const id = key === 'min_brightness' ? 64515 : 64516;
                payload = {[id]: {value: utils.mapNumberRange(value, 1, 255, 0, 1000), type: 0x21}};
            } else if (key === 'light_type' || key === 'switch_type') {
                const lookup = key === 'light_type' ? {led: 0, incandescent: 1, halogen: 2} : {momentary: 0, toggle: 1, state: 2};
                payload = {64514: {value: lookup[value], type: 0x20}};
            }
            await entity.write('genLevelCtrl', payload, utils.getOptions(meta.mapped, entity));
            return {state: {[key]: value}};
        },
        convertGet: async (entity, key, meta) => {
            let id = null;
            if (key === 'min_brightness') id = 64515;
            if (key === 'max_brightness') id = 64516;
            if (key === 'light_type' || key === 'switch_type') id = 64514;
            await entity.read('genLevelCtrl', [id]);
        },
    },
    TS110E_onoff_brightness: {
        key: ['state', 'brightness'],
        options: [],
        convertSet: async (entity, key, value, meta) => {
            const {message, state} = meta;
            if (message.state === 'OFF' || (message.hasOwnProperty('state') && !message.hasOwnProperty('brightness'))) {
                return await tz.on_off.convertSet(entity, key, value, meta);
            } else if (message.hasOwnProperty('brightness')) {
                // set brightness
                if (state.state === 'OFF') {
                    await entity.command('genOnOff', 'on', {}, utils.getOptions(meta.mapped, entity));
                }

                const level = utils.mapNumberRange(message.brightness, 0, 254, 0, 1000);
                await entity.command('genLevelCtrl', 'moveToLevelTuya', {level, transtime: 100}, utils.getOptions(meta.mapped, entity));
                return {state: {state: 'ON', brightness: message.brightness}};
            }
        },
        convertGet: async (entity, key, meta) => {
            if (key === 'state') await tz.on_off.convertGet(entity, key, meta);
            if (key === 'brightness') await entity.read('genLevelCtrl', [61440]);
        },
    },
    TS110E_light_onoff_brightness: {
        ...tz.light_onoff_brightness,
        convertSet: async (entity, key, value, meta) => {
            const {message} = meta;
            if (message.state === 'ON' || message.brightness > 1) {
                // Does not turn off with physical press when turned on with just moveToLevelWithOnOff, required on before.
                // https://github.com/Koenkk/zigbee2mqtt/issues/15902#issuecomment-1382848150
                await entity.command('genOnOff', 'on', {}, utils.getOptions(meta.mapped, entity));
            }
            return tz.light_onoff_brightness.convertSet(entity, key, value, meta);
        },
    },
    SA12IZL_silence_siren: {
        key: ['silence_siren'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, 16, value);
        },
    },
    SA12IZL_alarm: {
        key: ['alarm'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointEnum(entity, 20, {true: 0, false: 1}[value]);
        },
    },
    hpsz: {
        key: ['led_state'],
        convertSet: async (entity, key, value, meta) => {
            await tuya.sendDataPointBool(entity, tuya.dataPoints.HPSZLEDState, value);
        },
    },
    TS0504B_color: {
        key: ['color'],
        convertSet: async (entity, key, value, meta) => {
            const color = libColor.Color.fromConverterArg(value);
            console.log(color);
            const enableWhite =
                (color.isRGB() && (color.rgb.red === 1 && color.rgb.green === 1 && color.rgb.blue === 1)) ||
                // Zigbee2MQTT frontend white value
                (color.isXY() && (color.xy.x === 0.3125 || color.xy.y === 0.32894736842105265)) ||
                // Home Assistant white color picker value
                (color.isXY() && (color.xy.x === 0.323 || color.xy.y === 0.329));

            if (enableWhite) {
                await entity.command('lightingColorCtrl', 'tuyaRgbMode', {enable: false});
                const newState = {color_mode: 'xy'};
                if (color.isXY()) {
                    newState.color = color.xy;
                } else {
                    newState.color = color.rgb.gammaCorrected().toXY().rounded(4);
                }
                return {state: libColor.syncColorState(newState, meta.state, entity, meta.options, meta.logger)};
            } else {
                return await tz.light_color.convertSet(entity, key, value, meta);
            }
        },
    },
    TS0224: {
        key: ['light', 'duration', 'volume'],
        convertSet: async (entity, key, value, meta) => {
            if (key === 'light') {
                await entity.command('genOnOff', value.toLowerCase() === 'on' ? 'on' : 'off', {}, utils.getOptions(meta.mapped, entity));
            } else if (key === 'duration') {
                await entity.write('ssIasWd', {'maxDuration': value}, utils.getOptions(meta.mapped, entity));
            } else if (key === 'volume') {
                const lookup = {'mute': 0, 'low': 10, 'medium': 30, 'high': 50};
                value = value.toLowerCase();
                utils.validateValue(value, Object.keys(lookup));
                await entity.write('ssIasWd', {0x0002: {value: lookup[value], type: 0x0a}}, utils.getOptions(meta.mapped, entity));
            }
            return {state: {[key]: value}};
        },
    },
    zb_sm_cover: {
        key: ['state', 'position', 'reverse_direction', 'top_limit', 'bottom_limit', 'favorite_position', 'goto_positon', 'report'],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'position': {
                const invert = (meta.state) ? !meta.state.invert_cover : false;
                value = invert ? 100 - value : value;
                if (value >= 0 && value <= 100) {
                    await tuya.sendDataPointValue(entity, tuya.dataPoints.coverPosition, value);
                } else {
                    throw new Error('TuYa_cover_control: Curtain motor position is out of range');
                }
                break;
            }
            case 'state': {
                const stateEnums = tuya.getCoverStateEnums(meta.device.manufacturerName);
                meta.logger.debug(`TuYa_cover_control: Using state enums for ${meta.device.manufacturerName}:
                ${JSON.stringify(stateEnums)}`);

                value = value.toLowerCase();
                switch (value) {
                case 'close':
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.state, stateEnums.close);
                    break;
                case 'open':
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.state, stateEnums.open);
                    break;
                case 'stop':
                    await tuya.sendDataPointEnum(entity, tuya.dataPoints.state, stateEnums.stop);
                    break;
                default:
                    throw new Error('TuYa_cover_control: Invalid command received');
                }
                break;
            }
            case 'reverse_direction': {
                meta.logger.info(`Motor direction ${(value) ? 'reverse' : 'forward'}`);
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.motorDirection, (value) ? 1 : 0);
                break;
            }
            case 'top_limit': {
                await tuya.sendDataPointEnum(entity, 104, {'SET': 0, 'CLEAR': 1}[value]);
                break;
            }
            case 'bottom_limit': {
                await tuya.sendDataPointEnum(entity, 103, {'SET': 0, 'CLEAR': 1}[value]);
                break;
            }
            case 'favorite_position': {
                await tuya.sendDataPointValue(entity, 115, value);
                break;
            }
            case 'goto_positon': {
                if (value == 'FAVORITE') {
                    value = (meta.state) ? meta.state.favorite_position : null;
                } else {
                    value = parseInt(value);
                }
                return tz.tuya_cover_control.convertSet(entity, 'position', value, meta);
            }
            case 'report': {
                await tuya.sendDataPointBool(entity, 116, 0);
                break;
            }
            }
        },
    },
    x5h_thermostat: {
        key: ['system_mode', 'current_heating_setpoint', 'sensor', 'brightness_state', 'sound', 'frost_protection', 'week', 'factory_reset',
            'local_temperature_calibration', 'heating_temp_limit', 'deadzone_temperature', 'upper_temp', 'preset', 'child_lock',
            'schedule'],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'system_mode':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.x5hState, value === 'heat');
                break;
            case 'preset': {
                value = value.toLowerCase();
                const lookup = {manual: 0, program: 1};
                utils.validateValue(value, Object.keys(lookup));
                value = lookup[value];
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.x5hMode, value);
                break;
            }
            case 'upper_temp':
                if (value >= 35 && value <= 95) {
                    await tuya.sendDataPointValue(entity, tuya.dataPoints.x5hSetTempCeiling, value);
                    const setpoint = globalStore.getValue(entity, 'currentHeatingSetpoint', 20);
                    const setpointRaw = Math.round(setpoint * 10);
                    await new Promise((r) => setTimeout(r, 500));
                    await tuya.sendDataPointValue(entity, tuya.dataPoints.x5hSetTemp, setpointRaw);
                } else {
                    throw new Error('Supported values are in range [35, 95]');
                }
                break;
            case 'deadzone_temperature':
                if (value >= 0.5 && value <= 9.5) {
                    value = Math.round(value * 10);
                    await tuya.sendDataPointValue(entity, tuya.dataPoints.x5hTempDiff, value);
                } else {
                    throw new Error('Supported values are in range [0.5, 9.5]');
                }
                break;
            case 'heating_temp_limit':
                if (value >= 5 && value <= 60) {
                    await tuya.sendDataPointValue(entity, tuya.dataPoints.x5hProtectionTempLimit, value);
                } else {
                    throw new Error('Supported values are in range [5, 60]');
                }
                break;
            case 'local_temperature_calibration':
                if (value >= -9.9 && value <= 9.9) {
                    value = Math.round(value * 10);

                    if (value < 0) {
                        value = 0xFFFFFFFF + value + 1;
                    }

                    await tuya.sendDataPointValue(entity, tuya.dataPoints.x5hTempCorrection, value);
                } else {
                    throw new Error('Supported values are in range [-9.9, 9.9]');
                }
                break;
            case 'factory_reset':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.x5hFactoryReset, value === 'ON');
                break;
            case 'week':
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.x5hWorkingDaySetting,
                    utils.getKey(tuya.thermostatWeekFormat, value, value, Number));
                break;
            case 'frost_protection':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.x5hFrostProtection, value === 'ON');
                break;
            case 'sound':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.x5hSound, value === 'ON');
                break;
            case 'brightness_state': {
                value = value.toLowerCase();
                const lookup = {off: 0, low: 1, medium: 2, high: 3};
                utils.validateValue(value, Object.keys(lookup));
                value = lookup[value];
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.x5hBackplaneBrightness, value);
                break;
            }
            case 'sensor': {
                value = value.toLowerCase();
                const lookup = {'internal': 0, 'external': 1, 'both': 2};
                utils.validateValue(value, Object.keys(lookup));
                value = lookup[value];
                await tuya.sendDataPointEnum(entity, tuya.dataPoints.x5hSensorSelection, value);
                break;
            }
            case 'current_heating_setpoint':
                if (value >= 5 && value <= 60) {
                    value = Math.round(value * 10);
                    await tuya.sendDataPointValue(entity, tuya.dataPoints.x5hSetTemp, value);
                } else {
                    throw new Error(`Unsupported value: ${value}`);
                }
                break;
            case 'child_lock':
                await tuya.sendDataPointBool(entity, tuya.dataPoints.x5hChildLock, value === 'LOCK');
                break;
            case 'schedule': {
                const periods = value.split(' ');
                const periodsNumber = 8;
                const payload = [];

                for (let i = 0; i < periodsNumber; i++) {
                    const timeTemp = periods[i].split('/');
                    const hm = timeTemp[0].split(':', 2);
                    const h = parseInt(hm[0]);
                    const m = parseInt(hm[1]);
                    const temp = parseFloat(timeTemp[1]);

                    if (h < 0 || h >= 24 || m < 0 || m >= 60 || temp < 5 || temp > 60) {
                        throw new Error('Invalid hour, minute or temperature of: ' + periods[i]);
                    }

                    const tempHexArray = tuya.convertDecimalValueTo2ByteHexArray(Math.round(temp * 10));
                    // 1 byte for hour, 1 byte for minutes, 2 bytes for temperature
                    payload.push(h, m, ...tempHexArray);
                }

                await tuya.sendDataPointRaw(entity, tuya.dataPoints.x5hWeeklyProcedure, payload);
                break;
            }
            default:
                break;
            }
        },
    },
    temperature_unit: {
        key: ['temperature_unit'],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'temperature_unit': {
                await entity.write('manuSpecificTuya_2', {'57355': {value: {'celsius': 0, 'fahrenheit': 1}[value], type: 48}});
                break;
            }
            default: // Unknown key
                meta.logger.warn(`Unhandled key ${key}`);
            }
        },
    },
    TS011F_threshold: {
        key: [
            'temperature_threshold', 'temperature_breaker', 'power_threshold', 'power_breaker',
            'over_current_threshold', 'over_current_breaker', 'over_voltage_threshold', 'over_voltage_breaker',
            'under_voltage_threshold', 'under_voltage_breaker',
        ],
        convertSet: async (entity, key, value, meta) => {
            switch (key) {
            case 'temperature_threshold': {
                const state = meta.state['temperature_breaker'];
                const buf = Buffer.from([5, {'ON': 1, 'OFF': 0}[state], 0, value]);
                await entity.command('manuSpecificTuya_3', 'setOptions2', {data: buf});
                break;
            }
            case 'temperature_breaker': {
                const threshold = meta.state['temperature_threshold'];
                const buf = Buffer.from([5, {'ON': 1, 'OFF': 0}[value], 0, threshold]);
                await entity.command('manuSpecificTuya_3', 'setOptions2', {data: buf});
                break;
            }
            case 'power_threshold': {
                const state = meta.state['power_breaker'];
                const buf = Buffer.from([7, {'ON': 1, 'OFF': 0}[state], 0, value]);
                await entity.command('manuSpecificTuya_3', 'setOptions2', {data: buf});
                break;
            }
            case 'power_breaker': {
                const threshold = meta.state['power_threshold'];
                const buf = Buffer.from([7, {'ON': 1, 'OFF': 0}[value], 0, threshold]);
                await entity.command('manuSpecificTuya_3', 'setOptions2', {data: buf});
                break;
            }
            case 'over_current_threshold': {
                const state = meta.state['over_current_breaker'];
                const buf = Buffer.from([1, {'ON': 1, 'OFF': 0}[state], 0, value]);
                await entity.command('manuSpecificTuya_3', 'setOptions3', {data: buf});
                break;
            }
            case 'over_current_breaker': {
                const threshold = meta.state['over_current_threshold'];
                const buf = Buffer.from([1, {'ON': 1, 'OFF': 0}[value], 0, threshold]);
                await entity.command('manuSpecificTuya_3', 'setOptions3', {data: buf});
                break;
            }
            case 'over_voltage_threshold': {
                const state = meta.state['over_voltage_breaker'];
                const buf = Buffer.from([3, {'ON': 1, 'OFF': 0}[state], 0, value]);
                await entity.command('manuSpecificTuya_3', 'setOptions3', {data: buf});
                break;
            }
            case 'over_voltage_breaker': {
                const threshold = meta.state['over_voltage_threshold'];
                const buf = Buffer.from([3, {'ON': 1, 'OFF': 0}[value], 0, threshold]);
                await entity.command('manuSpecificTuya_3', 'setOptions3', {data: buf});
                break;
            }
            case 'under_voltage_threshold': {
                const state = meta.state['under_voltage_breaker'];
                const buf = Buffer.from([4, {'ON': 1, 'OFF': 0}[state], 0, value]);
                await entity.command('manuSpecificTuya_3', 'setOptions3', {data: buf});
                break;
            }
            case 'under_voltage_breaker': {
                const threshold = meta.state['under_voltage_threshold'];
                const buf = Buffer.from([4, {'ON': 1, 'OFF': 0}[value], 0, threshold]);
                await entity.command('manuSpecificTuya_3', 'setOptions3', {data: buf});
                break;
            }
            default: // Unknown key
                meta.logger.warn(`Unhandled key ${key}`);
            }
        },
    },
};

const fzLocal = {
    TS110E: {
        cluster: 'genLevelCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty('64515')) {
                result['min_brightness'] = utils.mapNumberRange(msg.data['64515'], 0, 1000, 1, 255);
            }
            if (msg.data.hasOwnProperty('64516')) {
                result['max_brightness'] = utils.mapNumberRange(msg.data['64516'], 0, 1000, 1, 255);
            }
            if (msg.data.hasOwnProperty('61440')) {
                result['brightness'] = utils.mapNumberRange(msg.data['61440'], 0, 1000, 0, 255);
            }
            return result;
        },
    },
    TS110E_light_type: {
        cluster: 'genLevelCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty('64514')) {
                const lookup = {0: 'led', 1: 'incandescent', 2: 'halogen'};
                result['light_type'] = lookup[msg.data['64514']];
            }
            return result;
        },
    },
    TS110E_switch_type: {
        cluster: 'genLevelCtrl',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty('64514')) {
                const lookup = {0: 'momentary', 1: 'toggle', 2: 'state'};
                const propertyName = utils.postfixWithEndpointName('switch_type', msg, model, meta);
                result[propertyName] = lookup[msg.data['64514']];
            }
            return result;
        },
    },
    SA12IZL: {
        cluster: 'manuSpecificTuya',
        type: ['commandDataResponse', 'commandDataReport'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            for (const dpValue of msg.data.dpValues) {
                const dp = dpValue.dp;
                const value = tuya.getDataValue(dpValue);
                switch (dp) {
                case tuya.dataPoints.state:
                    result.smoke = value === 0;
                    break;
                case 15:
                    result.battery = value;
                    break;
                case 16:
                    result.silence_siren = value;
                    break;
                case 20: {
                    const alarm = {0: true, 1: false};
                    result.alarm = alarm[value];
                    break;
                }
                default:
                    meta.logger.warn(`zigbee-herdsman-converters:SA12IZL: NOT RECOGNIZED DP #${
                        dp} with data ${JSON.stringify(dpValue)}`);
                }
            }
            return result;
        },
    },
    tuya_dinrail_switch2: {
        cluster: 'manuSpecificTuya',
        type: ['commandDataReport', 'commandDataResponse', 'commandActiveStatusReport'],
        convert: (model, msg, publish, options, meta) => {
            const dpValue = tuya.firstDpValue(msg, meta, 'tuya_dinrail_switch2');
            const dp = dpValue.dp;
            const value = tuya.getDataValue(dpValue);
            const state = value ? 'ON' : 'OFF';

            switch (dp) {
            case tuya.dataPoints.state: // DPID that we added to common
                return {state: state};
            case tuya.dataPoints.dinrailPowerMeterTotalEnergy2:
                return {energy: value/100};
            case tuya.dataPoints.dinrailPowerMeterPower2:
                return {power: value};
            default:
                meta.logger.warn(`zigbee-herdsman-converters:TuyaDinRailSwitch: NOT RECOGNIZED DP ` +
                    `#${dp} with data ${JSON.stringify(dpValue)}`);
            }
        },
    },
    hpsz: {
        cluster: 'manuSpecificTuya',
        type: ['commandDataResponse', 'commandDataReport'],
        convert: (model, msg, publish, options, meta) => {
            const dpValue = tuya.firstDpValue(msg, meta, 'hpsz');
            const dp = dpValue.dp;
            const value = tuya.getDataValue(dpValue);
            let result = null;
            switch (dp) {
            case tuya.dataPoints.HPSZInductionState:
                result = {presence: value === 1};
                break;
            case tuya.dataPoints.HPSZPresenceTime:
                result = {duration_of_attendance: value};
                break;
            case tuya.dataPoints.HPSZLeavingTime:
                result = {duration_of_absence: value};
                break;
            case tuya.dataPoints.HPSZLEDState:
                result = {led_state: value};
                break;
            default:
                meta.logger.warn(`zigbee-herdsman-converters:hpsz: NOT RECOGNIZED DP #${
                    dp} with data ${JSON.stringify(dpValue)}`);
            }
            return result;
        },
    },
    scenes_recall_scene_65029: {
        cluster: '65029',
        type: ['raw', 'attributeReport'],
        convert: (model, msg, publish, options, meta) => {
            const id = meta.device.modelID === '005f0c3b' ? msg.data[0] : msg.data[msg.data.length - 1];
            return {action: `scene_${id}`};
        },
    },
    TS0201_battery: {
        cluster: 'genPowerCfg',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            // https://github.com/Koenkk/zigbee2mqtt/issues/11470
            if (msg.data.batteryPercentageRemaining == 200 && msg.data.batteryVoltage < 30) return;
            return fz.battery.convert(model, msg, publish, options, meta);
        },
    },
    TS0201_humidity: {
        ...fz.humidity,
        convert: (model, msg, publish, options, meta) => {
            if (meta.device.manufacturerName === '_TZ3000_ywagc4rj') {
                msg.data['measuredValue'] *= 10;
            }
            return fz.humidity.convert(model, msg, publish, options, meta);
        },
    },
    TS0222: {
        cluster: 'manuSpecificTuya',
        type: ['commandDataResponse', 'commandDataReport'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            for (const dpValue of msg.data.dpValues) {
                const dp = dpValue.dp;
                const value = tuya.getDataValue(dpValue);
                switch (dp) {
                case 2:
                    result.illuminance = value;
                    result.illuminance_lux = value;
                    break;
                case 4:
                    result.battery = value;
                    break;
                default:
                    meta.logger.warn(`zigbee-herdsman-converters:TS0222 Unrecognized DP #${dp} with data ${JSON.stringify(dpValue)}`);
                }
            }
            return result;
        },
    },
    ZM35HQ_battery: {
        cluster: 'manuSpecificTuya',
        type: ['commandDataReport'],
        convert: (model, msg, publish, options, meta) => {
            const dpValue = tuya.firstDpValue(msg, meta, 'ZM35HQ');
            const dp = dpValue.dp;
            const value = tuya.getDataValue(dpValue);
            if (dp === 4) return {battery: value};
            else {
                meta.logger.warn(`zigbee-herdsman-converters:ZM35HQ: NOT RECOGNIZED DP #${dp} with data ${JSON.stringify(dpValue)}`);
            }
        },
    },
    zb_sm_cover: {
        cluster: 'manuSpecificTuya',
        type: ['commandDataReport', 'commandDataResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            for (const dpValue of msg.data.dpValues) {
                const dp = dpValue.dp;
                const value = tuya.getDataValue(dpValue);

                switch (dp) {
                case tuya.dataPoints.coverPosition: // Started moving to position (triggered from Zigbee)
                case tuya.dataPoints.coverArrived: { // Arrived at position
                    const invert = (meta.state) ? !meta.state.invert_cover : false;
                    const position = invert ? 100 - (value & 0xFF) : (value & 0xFF);
                    if (position > 0 && position <= 100) {
                        result.position = position;
                        result.state = 'OPEN';
                    } else if (position == 0) { // Report fully closed
                        result.position = position;
                        result.state = 'CLOSE';
                    }
                    break;
                }
                case 1: // report state
                    result.state = {0: 'OPEN', 1: 'STOP', 2: 'CLOSE'}[value];
                    break;
                case tuya.dataPoints.motorDirection: // reverse direction
                    result.reverse_direction = (value == 1);
                    break;
                case 10: // cycle time
                    result.cycle_time = value;
                    break;
                case 101: // model
                    result.motor_type = {0: '', 1: 'AM0/6-28R-Sm', 2: 'AM0/10-19R-Sm',
                        3: 'AM1/10-13R-Sm', 4: 'AM1/20-13R-Sm', 5: 'AM1/30-13R-Sm'}[value];
                    break;
                case 102: // cycles
                    result.cycle_count = value;
                    break;
                case 103: // set or clear bottom limit
                    result.bottom_limit = {0: 'SET', 1: 'CLEAR'}[value];
                    break;
                case 104: // set or clear top limit
                    result.top_limit = {0: 'SET', 1: 'CLEAR'}[value];
                    break;
                case 109: // active power
                    result.active_power = value;
                    break;
                case 115: // favorite_position
                    result.favorite_position = (value != 101) ? value : null;
                    break;
                case 116: // report confirmation
                    break;
                case 121: // running state
                    result.motor_state = {0: 'OPENING', 1: 'STOPPED', 2: 'CLOSING'}[value];
                    result.running = (value !== 1) ? true : false;
                    break;
                default: // Unknown code
                    meta.logger.warn(`zb_sm_tuya_cover: Unhandled DP #${dp} for ${meta.device.manufacturerName}:
                    ${JSON.stringify(dpValue)}`);
                }
            }
            return result;
        },
    },
    x5h_thermostat: {
        cluster: 'manuSpecificTuya',
        type: ['commandDataResponse', 'commandDataReport'],
        convert: (model, msg, publish, options, meta) => {
            const dpValue = tuya.firstDpValue(msg, meta, 'x5h_thermostat');
            const dp = dpValue.dp;
            const value = tuya.getDataValue(dpValue);

            switch (dp) {
            case tuya.dataPoints.x5hState: {
                return {system_mode: value ? 'heat' : 'off'};
            }
            case tuya.dataPoints.x5hWorkingStatus: {
                return {running_state: value ? 'heat' : 'idle'};
            }
            case tuya.dataPoints.x5hSound: {
                return {sound: value ? 'ON' : 'OFF'};
            }
            case tuya.dataPoints.x5hFrostProtection: {
                return {frost_protection: value ? 'ON' : 'OFF'};
            }
            case tuya.dataPoints.x5hWorkingDaySetting: {
                return {week: tuya.thermostatWeekFormat[value]};
            }
            case tuya.dataPoints.x5hFactoryReset: {
                if (value) {
                    clearTimeout(globalStore.getValue(msg.endpoint, 'factoryResetTimer'));
                    const timer = setTimeout(() => publish({factory_reset: 'OFF'}), 60 * 1000);
                    globalStore.putValue(msg.endpoint, 'factoryResetTimer', timer);
                    meta.logger.info('The thermostat is resetting now. It will be available in 1 minute.');
                }

                return {factory_reset: value ? 'ON' : 'OFF'};
            }
            case tuya.dataPoints.x5hTempDiff: {
                return {deadzone_temperature: parseFloat((value / 10).toFixed(1))};
            }
            case tuya.dataPoints.x5hProtectionTempLimit: {
                return {heating_temp_limit: value};
            }
            case tuya.dataPoints.x5hBackplaneBrightness: {
                const lookup = {0: 'off', 1: 'low', 2: 'medium', 3: 'high'};

                if (value >= 0 && value <= 3) {
                    globalStore.putValue(msg.endpoint, 'brightnessState', value);
                    return {brightness_state: lookup[value]};
                }

                // Sometimes, for example on thermostat restart, it sends message like:
                // {"dpValues":[{"data":{"data":[90],"type":"Buffer"},"datatype":4,"dp":104}
                // It doesn't represent any brightness value and brightness remains the previous value
                const lastValue = globalStore.getValue(msg.endpoint, 'brightnessState') || 1;
                return {brightness_state: lookup[lastValue]};
            }
            case tuya.dataPoints.x5hWeeklyProcedure: {
                const periods = [];
                const periodSize = 4;
                const periodsNumber = 8;

                for (let i = 0; i < periodsNumber; i++) {
                    const hours = value[i * periodSize];
                    const minutes = value[i * periodSize + 1];
                    const tempHexArray = [value[i * periodSize + 2], value[i * periodSize + 3]];
                    const tempRaw = Buffer.from(tempHexArray).readUIntBE(0, tempHexArray.length);
                    const strHours = hours.toString().padStart(2, '0');
                    const strMinutes = minutes.toString().padStart(2, '0');
                    const temp = parseFloat((tempRaw / 10).toFixed(1));
                    periods.push(`${strHours}:${strMinutes}/${temp}`);
                }

                const schedule = periods.join(' ');
                return {schedule};
            }
            case tuya.dataPoints.x5hChildLock: {
                return {child_lock: value ? 'LOCK' : 'UNLOCK'};
            }
            case tuya.dataPoints.x5hSetTemp: {
                const setpoint = parseFloat((value / 10).toFixed(1));
                globalStore.putValue(msg.endpoint, 'currentHeatingSetpoint', setpoint);
                return {current_heating_setpoint: setpoint};
            }
            case tuya.dataPoints.x5hSetTempCeiling: {
                return {upper_temp: value};
            }
            case tuya.dataPoints.x5hCurrentTemp: {
                const temperature = value & (1 << 15) ? value - (1 << 16) + 1 : value;
                return {local_temperature: parseFloat((temperature / 10).toFixed(1))};
            }
            case tuya.dataPoints.x5hTempCorrection: {
                return {local_temperature_calibration: parseFloat((value / 10).toFixed(1))};
            }
            case tuya.dataPoints.x5hMode: {
                const lookup = {0: 'manual', 1: 'program'};
                return {preset: lookup[value]};
            }
            case tuya.dataPoints.x5hSensorSelection: {
                const lookup = {0: 'internal', 1: 'external', 2: 'both'};
                return {sensor: lookup[value]};
            }
            case tuya.dataPoints.x5hOutputReverse: {
                return {output_reverse: value};
            }
            default: {
                meta.logger.warn(`fromZigbee:x5h_thermostat: Unrecognized DP #${dp} with data ${JSON.stringify(dpValue)}`);
            }
            }
        },
    },
    humidity10: {
        cluster: 'msRelativeHumidity',
        type: ['attributeReport', 'readResponse'],
        options: [exposes.options.precision('humidity'), exposes.options.calibration('humidity')],
        convert: (model, msg, publish, options, meta) => {
            const humidity = parseFloat(msg.data['measuredValue']) / 10.0;
            if (humidity >= 0 && humidity <= 100) {
                return {humidity: utils.calibrateAndPrecisionRoundOptions(humidity, options, 'humidity')};
            }
        },
    },
    temperature_unit: {
        cluster: 'manuSpecificTuya_2',
        type: ['attributeReport', 'readResponse'],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            if (msg.data.hasOwnProperty('57355')) {
                result.temperature_unit = {'0': 'celsius', '1': 'fahrenheit'}[msg.data['57355']];
            }
            return result;
        },
    },
    TS011F_electrical_measurement: {
        ...fz.electrical_measurement,
        convert: (model, msg, publish, options, meta) => {
            const result = fz.electrical_measurement.convert(model, msg, publish, options, meta);

            // Skip the first reported 0 values as this may be a false measurement
            // https://github.com/Koenkk/zigbee2mqtt/issues/16709#issuecomment-1509599046
            if (['_TZ3000_gvn91tmx', '_TZ3000_amdymr7l'].includes(meta.device.manufacturerName)) {
                for (const key of ['power', 'current', 'voltage']) {
                    const value = result[key];
                    if (value === 0 && globalStore.getValue(msg.endpoint, key) !== 0) {
                        delete result[key];
                    }
                    globalStore.putValue(msg.endpoint, key, value);
                }
            }
            return result;
        },
    },
    TS011F_threshold: {
        cluster: 'manuSpecificTuya_3',
        type: 'raw',
        convert: (model, msg, publish, options, meta) => {
            const splitToAttributes = (value) => {
                const result = {};
                const len = value.length;
                let i = 0;
                while (i < len) {
                    const key = value.readUInt8(i);
                    result[key] = [value.readUInt8(i+1), value.readUInt16BE(i+2)];
                    i += 4;
                }
                return result;
            };
            const lookup = {0: 'OFF', 1: 'ON'};
            const command = msg.data[2];
            const data = msg.data.slice(3);
            if (command == 0xE6) {
                const value = splitToAttributes(data);
                return {
                    'temperature_threshold': value[0x05][1],
                    'temperature_breaker': lookup[value[0x05][0]],
                    'power_threshold': value[0x07][1],
                    'power_breaker': lookup[value[0x07][0]],
                };
            }
            if (command == 0xE7) {
                const value = splitToAttributes(data);
                return {
                    'over_current_threshold': value[0x01][1],
                    'over_current_breaker': lookup[value[0x01][0]],
                    'over_voltage_threshold': value[0x03][1],
                    'over_voltage_breaker': lookup[value[0x03][0]],
                    'under_voltage_threshold': value[0x04][1],
                    'under_voltage_breaker': lookup[value[0x04][0]],
                };
            }
        },
    },
};

module.exports = [
    {
        zigbeeModel: ['TS0204'],
        model: 'TS0204',
        vendor: 'TuYa',
        description: 'Gas sensor',
        whiteLabel: [{vendor: 'Tesla Smart', model: 'TSL-SEN-GAS'}],
        fromZigbee: [fz.ias_gas_alarm_1, fz.ignore_basic_report],
        toZigbee: [],
        exposes: [e.gas(), e.tamper()],
    },
    {
        zigbeeModel: ['TS0205'],
        model: 'TS0205',
        vendor: 'TuYa',
        description: 'Smoke sensor',
        whiteLabel: [{vendor: 'Tesla Smart', model: 'TSL-SEN-SMOKE'}],
        fromZigbee: [fz.ias_smoke_alarm_1, fz.battery, fz.ignore_basic_report],
        toZigbee: [],
        exposes: [e.smoke(), e.battery_low(), e.tamper(), e.battery()],
    },
    {
        zigbeeModel: ['TS0111'],
        model: 'TS0111',
        vendor: 'TuYa',
        description: 'Socket',
        extend: tuya.extend.switch(),
    },
    {
        zigbeeModel: ['TS0218'],
        model: 'TS0218',
        vendor: 'TuYa',
        description: 'Button',
        fromZigbee: [fz.legacy.TS0218_click, fz.battery],
        exposes: [e.battery(), e.action(['click'])],
        toZigbee: [],
    },
    {
        zigbeeModel: ['TS0203'],
        model: 'TS0203',
        vendor: 'TuYa',
        description: 'Door sensor',
        fromZigbee: [fz.ias_contact_alarm_1, fz.battery, fz.ignore_basic_report, fz.ias_contact_alarm_1_report],
        toZigbee: [],
        exposes: [e.contact(), e.battery_low(), e.tamper(), e.battery(), e.battery_voltage()],
        whiteLabel: [
            {vendor: 'CR Smart Home', model: 'TS0203'},
            {vendor: 'TuYa', model: 'iH-F001'},
            {vendor: 'Tesla Smart', model: 'TSL-SEN-DOOR'},
            {vendor: 'Cleverio', model: 'SS100'},
        ],
        configure: async (device, coordinatorEndpoint, logger) => {
            try {
                const endpoint = device.getEndpoint(1);
                await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
                await reporting.batteryPercentageRemaining(endpoint);
                await reporting.batteryVoltage(endpoint);
            } catch (error) {/* Fails for some*/}
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_bq5c8xfe'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_bjawzodf'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_qyflbnbj'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_vs0skpuc'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_9yapgbuv'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_zl1kmjqx'}],
        model: 'TS0601_temperature_humidity_sensor',
        vendor: 'TuYa',
        description: 'Temperature & humidity sensor',
        fromZigbee: [fz.tuya_temperature_humidity_sensor],
        toZigbee: [],
        exposes: (device, options) => {
            const exps = [e.temperature(), e.humidity(), e.battery()];
            if (!device || device.manufacturerName === '_TZE200_qyflbnbj') {
                exps.push(e.battery_low());
                exps.push(exposes.enum('battery_level', ea.STATE, ['low', 'middle', 'high']).withDescription('Battery level state'));
            }
            exps.push(e.linkquality());
            return exps;
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_nvups4nh']),
        model: 'TS0601_contact_temperature_humidity_sensor',
        vendor: 'TuYa',
        description: 'Contact, temperature and humidity sensor',
        fromZigbee: [tuya.fz.datapoints, tuya.fz.gateway_connection_status],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [e.contact(), e.temperature(), e.humidity(), e.battery()],
        meta: {
            tuyaDatapoints: [
                [1, 'contact', tuya.valueConverter.trueFalseInvert],
                [2, 'battery', tuya.valueConverter.raw],
                [7, 'temperature', tuya.valueConverter.divideBy10],
                [8, 'humidity', tuya.valueConverter.raw],
            ],
        },
        whiteLabel: [
            tuya.whitelabel('Aubess', '1005005194831629', 'Contact, temperature and humidity sensor', ['_TZE200_nvups4nh']),
        ],
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_vzqtvljm'}],
        model: 'TS0601_illuminance_temperature_humidity_sensor',
        vendor: 'TuYa',
        description: 'Illuminance, temperature & humidity sensor',
        fromZigbee: [fz.tuya_illuminance_temperature_humidity_sensor],
        toZigbee: [],
        exposes: [e.temperature(), e.humidity(), e.illuminance_lux(), e.battery()],
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_8ygsuhe1'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_yvx5lh6k'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_ryfmq5rl'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_c2fmom5z'}],
        model: 'TS0601_air_quality_sensor',
        vendor: 'TuYa',
        description: 'Air quality sensor',
        fromZigbee: [fz.tuya_air_quality],
        toZigbee: [],
        exposes: [e.temperature(), e.humidity(), e.co2(), e.voc().withUnit('ppm'), e.formaldehyd()],
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_dwcarsat'}],
        model: 'TS0601_smart_air_house_keeper',
        vendor: 'TuYa',
        description: 'Smart air house keeper',
        fromZigbee: [fz.tuya_air_quality],
        toZigbee: [],
        exposes: [e.temperature(), e.humidity(), e.co2(), e.voc().withUnit('ppm'), e.formaldehyd().withUnit('µg/m³'),
            e.pm25().withValueMin(0).withValueMax(999).withValueStep(1)],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_ogkdpgy2', '_TZE200_3ejwxpmu']),
        model: 'TS0601_co2_sensor',
        vendor: 'TuYa',
        description: 'NDIR co2 sensor',
        fromZigbee: [fz.tuya_air_quality],
        toZigbee: [],
        exposes: [e.temperature(), e.humidity(), e.co2()],
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_7bztmfm1'}],
        model: 'TS0601_smart_CO_air_box',
        vendor: 'TuYa',
        description: 'Smart air box (carbon monoxide)',
        fromZigbee: [fz.tuya_CO],
        toZigbee: [],
        exposes: [e.carbon_monoxide(), e.co()],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_ggev5fsl', '_TZE200_u319yc66', '_TZE204_yojqa8xn']),
        model: 'TS0601_gas_sensor_1',
        vendor: 'TuYa',
        description: 'Gas sensor',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [e.gas(), tuya.exposes.selfTest(), tuya.exposes.selfTestResult(), tuya.exposes.faultAlarm(), tuya.exposes.silence()],
        meta: {
            tuyaDatapoints: [
                [1, 'gas', tuya.valueConverter.trueFalse0],
                [8, 'self_test', tuya.valueConverter.raw],
                [9, 'self_test_result', tuya.valueConverter.selfTestResult],
                [11, 'fault_alarm', tuya.valueConverter.trueFalse1],
                [16, 'silence', tuya.valueConverter.raw],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_yojqa8xn']),
        model: 'TS0601_gas_sensor_2',
        vendor: 'TuYa',
        description: 'Gas sensor',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [
            e.gas(), tuya.exposes.gasValue().withUnit('LEL'), tuya.exposes.selfTest(), tuya.exposes.selfTestResult(),
            tuya.exposes.silence(),
            exposes.enum('alarm_ringtone', ea.STATE_SET, ['1', '2', '3', '4', '5']).withDescription('Ringtone of the alarm'),
            exposes.numeric('alarm_time', ea.STATE_SET).withValueMin(1).withValueMax(180).withValueStep(1)
                .withUnit('s').withDescription('Alarm time'),
            exposes.binary('preheat', ea.STATE, true, false).withDescription('Indicates sensor preheat is active'),
        ],
        meta: {
            tuyaDatapoints: [
                [1, 'gas', tuya.valueConverter.trueFalseEnum0],
                [2, 'gas_value', tuya.valueConverter.divideBy10],
                [6, 'alarm_ringtone', tuya.valueConverterBasic.lookup({'1': 0, '2': 1, '3': 2, '4': 3, '5': 4})],
                [7, 'alarm_time', tuya.valueConverter.raw],
                [8, 'self_test', tuya.valueConverter.raw],
                [9, 'self_test_result', tuya.valueConverter.selfTestResult],
                [10, 'preheat', tuya.valueConverter.raw],
                [13, null, null], // alarm_switch; ignore for now since it is unclear what it does
                [16, 'silence', tuya.valueConverter.raw],
            ],
        },
    },
    {
        fingerprint: [{modelID: 'TS0001', manufacturerName: '_TZ3000_hktqahrq'}, {manufacturerName: '_TZ3000_hktqahrq'},
            {manufacturerName: '_TZ3000_q6a3tepg'}, {modelID: 'TS000F', manufacturerName: '_TZ3000_m9af2l6g'},
            {modelID: 'TS000F', manufacturerName: '_TZ3000_mx3vgyea'},
            {modelID: 'TS0001', manufacturerName: '_TZ3000_npzfdcof'},
            {modelID: 'TS0001', manufacturerName: '_TZ3000_5ng23zjs'},
            {modelID: 'TS0001', manufacturerName: '_TZ3000_rmjr4ufz'},
            {modelID: 'TS0001', manufacturerName: '_TZ3000_v7gnj3ad'},
            {modelID: 'TS0001', manufacturerName: '_TZ3000_3a9beq8a'},
            {modelID: 'TS0001', manufacturerName: '_TZ3000_ark8nv4y'},
            {modelID: 'TS0001', manufacturerName: '_TZ3000_mx3vgyea'},
            {modelID: 'TS0001', manufacturerName: '_TZ3000_qsp2pwtf'},
            {modelID: 'TS0001', manufacturerName: '_TZ3000_46t1rvdu'}],
        model: 'WHD02',
        vendor: 'TuYa',
        whiteLabel: [{vendor: 'TuYa', model: 'iHSW02'}, {vendor: 'Aubess', model: 'TMZ02'}],
        description: 'Wall switch module',
        extend: tuya.extend.switch({switchType: true}),
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
            await reporting.onOff(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS011F', manufacturerName: '_TZ3000_mvn6jl7x'},
            {modelID: 'TS011F', manufacturerName: '_TZ3000_raviyuvk'}, {modelID: 'TS011F', manufacturerName: '_TYZB01_hlla45kx'},
            {modelID: 'TS011F', manufacturerName: '_TZ3000_92qd4sqa'}, {modelID: 'TS011F', manufacturerName: '_TZ3000_zwaadvus'},
            {modelID: 'TS011F', manufacturerName: '_TZ3000_k6fvknrr'}, {modelID: 'TS011F', manufacturerName: '_TZ3000_6s5dc9lx'}],
        model: 'TS011F_2_gang_wall',
        vendor: 'TuYa',
        description: '2 gang wall outlet',
        extend: tuya.extend.switch({backlightModeLowMediumHigh: true, childLock: true, endpoints: ['l1', 'l2']}),
        whiteLabel: [{vendor: 'ClickSmart+', model: 'CMA30036'}],
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2};
        },
        meta: {multiEndpoint: true},
        configure: tuya.configureMagicPacket,
    },
    {
        fingerprint: [{modelID: 'TS011F', manufacturerName: '_TZ3000_rk2yzt0u'},
            {modelID: 'TS0001', manufacturerName: '_TZ3000_o4cjetlm'}, {manufacturerName: '_TZ3000_o4cjetlm'},
            {modelID: 'TS0001', manufacturerName: '_TZ3000_iedbgyxt'}, {modelID: 'TS0001', manufacturerName: '_TZ3000_h3noz0a5'},
            {modelID: 'TS0001', manufacturerName: '_TYZB01_4tlksk8a'}, {modelID: 'TS0011', manufacturerName: '_TYZB01_rifa0wlb'}],
        model: 'ZN231392',
        vendor: 'TuYa',
        description: 'Smart water/gas valve',
        extend: tuya.extend.switch({powerOnBehavior: true}),
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            await endpoint.read('genOnOff', ['onOff', 'moesStartUpOnOff']);
        },
    },
    {
        fingerprint: [{modelID: 'TS011F', manufacturerName: '_TZ3000_1hwjutgo'}, {modelID: 'TS011F', manufacturerName: '_TZ3000_lnggrqqi'}],
        model: 'TS011F_circuit_breaker',
        vendor: 'TuYa',
        description: 'Circuit breaker',
        extend: tuya.extend.switch(),
        whiteLabel: [{vendor: 'Mumubiz', model: 'ZJSB9-80Z'}],
    },
    {
        fingerprint: [{modelID: 'TS011F', manufacturerName: '_TZ3000_8fdayfch'}],
        model: 'TS011F_relay_switch',
        vendor: 'TuYa',
        description: 'Dry contact relay switch',
        extend: tuya.extend.switch(),
        whiteLabel: [{vendor: 'KTNNKG', model: 'ZB1248-10A'}],
    },
    {
        zigbeeModel: ['CK-BL702-AL-01(7009_Z102LG03-1)'],
        model: 'CK-BL702-AL-01',
        vendor: 'TuYa',
        description: 'Zigbee LED bulb',
        extend: tuya.extend.light_onoff_brightness_colortemp_color({colorTempRange: [142, 500]}),
    },
    {
        zigbeeModel: ['SM0001'],
        model: 'SM0001',
        vendor: 'TuYa',
        description: 'Switch',
        extend: tuya.extend.switch(),
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
        },
        whiteLabel: [
            tuya.whitelabel('ZemiSmart', 'ZM-H7', 'Hand wave wall smart switch', ['_TZ3000_jcqs2mrv']),
        ],
    },
    {
        zigbeeModel: ['TS0505B'],
        model: 'TS0505B_1',
        vendor: 'TuYa',
        description: 'Zigbee RGB+CCT light',
        whiteLabel: [{vendor: 'Mercator Ikuü', model: 'SMD4106W-RGB-ZB'},
            {vendor: 'TuYa', model: 'A5C-21F7-01'}, {vendor: 'Mercator Ikuü', model: 'S9E27LED9W-RGB-Z'},
            {vendor: 'Aldi', model: 'L122CB63H11A9.0W', description: 'LIGHTWAY smart home LED-lamp - bulb'},
            {vendor: 'Lidl', model: '14153706L', description: 'Livarno smart LED ceiling light'},
            {vendor: 'Zemismart', model: 'LXZB-ZB-09A', description: 'Zemismart LED Surface Mounted Downlight 9W RGBW'},
            {vendor: 'Feconn', model: 'FE-GU10-5W', description: 'Zigbee GU10 5W smart bulb'},
            {vendor: 'Nedis', model: 'ZBLC1E14'},
            tuya.whitelabel('Aldi', 'L122FF63H11A5.0W', 'LIGHTWAY smart home LED-lamp - spot', ['_TZ3000_j0gtlepx']),
            tuya.whitelabel('Aldi', 'L122AA63H11A6.5W', 'LIGHTWAY smart home LED-lamp - candle', ['_TZ3000_iivsrikg']),
            tuya.whitelabel('Aldi', 'C422AC11D41H140.0W', 'MEGOS LED panel RGB+CCT 40W 3600lm 62 x 62 cm', ['_TZ3000_v1srfw9x']),
            tuya.whitelabel('Aldi', 'C422AC14D41H140.0W', 'MEGOS LED panel RGB+CCT 40W 3600lm 30 x 120 cm', ['_TZ3000_gb5gaeca']),
            tuya.whitelabel('MiBoxer', 'FUT066Z', 'RGB+CCT LED Downlight', ['_TZ3210_zrvxvydd']),
            tuya.whitelabel('Miboxer', 'FUT039Z', 'RGB+CCT LED controller', ['_TZ3210_jicmoite']),
            tuya.whitelabel('Lidl', '14156506L', 'Livarno Lux smart LED mood light', ['_TZ3210_r0xgkft5']),
            tuya.whitelabel('Lidl', 'HG08010', 'Livarno Home outdoor spotlight', ['_TZ3210_umi6vbsz']),
            tuya.whitelabel('Lidl', 'HG08008', 'Livarno Home LED ceiling light', ['_TZ3210_p9ao60da']),
            tuya.whitelabel('TuYa', 'HG08007', 'Livarno Home outdoor LED band', ['_TZ3210_zbabx9wh']),
            tuya.whitelabel('Lidl', '14158704L', 'Livarno Home LED floor lamp, RGBW', ['_TZ3210_z1vlyufu']),
            tuya.whitelabel('Lidl', '14158804L', 'Livarno Home LED desk lamp RGBW', ['_TZ3210_hxtfthp5']),
            tuya.whitelabel('Lidl', 'HG07834A', 'Livarno Lux GU10 spot RGB', ['_TZ3000_quqaeew6']),
            tuya.whitelabel('Lidl', 'HG07834B', 'Livarno Lux E14 candle RGB', ['_TZ3000_th6zqqy6', '_TZ3000_wr6g6olr']),
            tuya.whitelabel('Lidl', 'HG08131C', 'Livarno Home outdoor E27 bulb in set with flare', ['_TZ3000_q50zhdsc']),
            tuya.whitelabel('Lidl', 'HG07834C', 'Livarno Lux E27 bulb RGB', ['_TZ3000_qd7hej8u']),
            tuya.whitelabel('Lidl', 'HG08383B', 'Livarno outdoor LED light chain', ['_TZ3000_bwlvyjwk']),
            tuya.whitelabel('Lidl', 'HG08383A', 'Livarno outdoor LED light chain', ['_TZ3000_taspddvq']),
            tuya.whitelabel('Garza Smart', 'Garza-Standard-A60', 'Standard A60 bulb', ['_TZ3210_sln7ah6r']),
            tuya.whitelabel('UR Lighting', 'TH008L10RGBCCT', '10W RGB+CCT downlight', ['_TZ3210_dn5higyl']),
            tuya.whitelabel('Lidl', 'HG08010', 'Livarno Home outdoor spotlight', ['_TZ3210_umi6vbsz']),
            tuya.whitelabel('Lidl', 'HG08008', 'Livarno Home LED ceiling light', ['_TZ3210_p9ao60da']),
            tuya.whitelabel('Lidl', 'HG08007', 'Livarno Home outdoor LED band', ['_TZ3210_zbabx9wh']),
        ],
        extend: tuya.extend.light_onoff_brightness_colortemp_color({colorTempRange: [153, 500], noConfigure: true}),
        configure: async (device, coordinatorEndpoint, logger) => {
            device.getEndpoint(1).saveClusterAttributeKeyValue('lightingColorCtrl', {colorCapabilities: 29});
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0505B', ['_TZ3210_c0s1xloa', '_TZ3210_iystcadi']),
        model: 'TS0505B_2',
        vendor: 'TuYa',
        description: 'Zigbee RGB+CCT light',
        whiteLabel: [
            tuya.whitelabel('Lidl', '14149505L/14149506L_2', 'Livarno Lux light bar RGB+CCT (black/white)', ['_TZ3210_iystcadi']),
            tuya.whitelabel('Lidl', '399629_2110', 'Livarno Lux Ceiling Panel RGB+CCT', ['_TZ3210_c0s1xloa']),
        ],
        toZigbee: [tz.on_off, tzLocal.led_control],
        fromZigbee: [fz.on_off, fz.tuya_led_controller, fz.brightness, fz.ignore_basic_report],
        exposes: [e.light_brightness_colortemp_colorhs([153, 500]).removeFeature('color_temp_startup')],
        configure: async (device, coordinatorEndpoint, logger) => {
            device.getEndpoint(1).saveClusterAttributeKeyValue('lightingColorCtrl', {colorCapabilities: 29});
        },
    },
    {
        zigbeeModel: ['TS0503B'],
        model: 'TS0503B',
        vendor: 'TuYa',
        description: 'Zigbee RGB light',
        whiteLabel: [{vendor: 'BTF-Lighting', model: 'C03Z'}],
        extend: tuya.extend.light_onoff_brightness_color(),
    },
    {
        zigbeeModel: ['TS0504B'],
        model: 'TS0504B',
        vendor: 'TuYa',
        description: 'Zigbee RGBW light',
        extend: tuya.extend.light_onoff_brightness_color(),
        exposes: [e.light_brightness_color({disablePowerOnBehavior: true})
            .setAccess('color_xy', ea.STATE_SET).setAccess('color_hs', ea.STATE_SET)],
        toZigbee: utils.replaceInArray(tuya.extend.light_onoff_brightness_color().toZigbee, [tz.light_color], [tzLocal.TS0504B_color]),
        meta: {applyRedFix: true},
    },
    {
        zigbeeModel: ['TS0501A'],
        model: 'TS0501A',
        description: 'Zigbee light',
        vendor: 'TuYa',
        extend: tuya.extend.light_onoff_brightness(),
        meta: {turnsOffAtBrightness1: false},
        whiteLabel: [
            tuya.whitelabel('Lidl', 'HG06463A', 'Livarno Lux E27 ST64 filament bulb', ['_TZ3000_j2w1dw29']),
            tuya.whitelabel('Lidl', 'HG06463B', 'Livarno Lux E27 G95 filament bulb', ['_TZ3000_nosnx7im']),
            tuya.whitelabel('Lidl', 'HG06462A', 'Livarno Lux E27 A60 filament bulb', ['_TZ3000_7dcddnye', '_TZ3000_nbnmw9nc']),
        ],
    },
    {
        zigbeeModel: ['TS0501B'],
        model: 'TS0501B',
        description: 'Zigbee light',
        vendor: 'TuYa',
        extend: tuya.extend.light_onoff_brightness(),
        whiteLabel: [
            tuya.whitelabel('Miboxer', 'FUT036Z', 'Single color LED controller', ['_TZ3210_dxroobu3', '_TZ3210_dbilpfqk']),
        ],
    },
    {
        fingerprint: tuya.fingerprint('TS0202', ['_TYZB01_vwqnz1sn']),
        model: 'TS0202_3',
        vendor: 'TuYa',
        description: 'Motion detector with illuminance',
        fromZigbee: [fz.ias_occupancy_alarm_1, fz.battery, fz.ignore_basic_report, fz.ias_occupancy_alarm_1_report, fz.illuminance],
        toZigbee: [],
        onEvent: tuya.onEventSetTime,
        configure: tuya.configureMagicPacket,
        exposes: [e.occupancy(), e.battery_low(), e.battery(), e.tamper(), e.illuminance_lux()],
    },
    {
        fingerprint: tuya.fingerprint('TS0202', ['_TZ3210_cwamkvua']),
        model: 'TS0202_2',
        vendor: 'TuYa',
        description: 'Motion sensor with scene switch',
        fromZigbee: [tuya.fz.datapoints, fz.ias_occupancy_alarm_1, fz.battery],
        toZigbee: [tuya.tz.datapoints],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.batteryPercentageRemaining(endpoint);
            await reporting.batteryVoltage(endpoint);
        },
        whiteLabel: [{vendor: 'Linkoze', model: 'LKMSZ001'}],
        exposes: [e.battery(), e.battery_voltage(), e.occupancy(), e.action(['single', 'double', 'hold']),
            exposes.enum('light', ea.STATE, ['dark', 'bright'])],
        meta: {
            tuyaDatapoints: [
                [102, 'light', tuya.valueConverterBasic.lookup({'dark': false, 'bright': true})],
                [101, 'action', tuya.valueConverterBasic.lookup({'single': 0, 'double': 1, 'hold': 2})],
            ],
        },
    },
    {
        fingerprint: [{modelID: 'TS0202', manufacturerName: '_TYZB01_jytabjkb'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_lltemgsf'},
            {modelID: 'TS0202', manufacturerName: '_TYZB01_5nr7ncpl'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_mg4dy6z6'},
            {modelID: 'TS0202', manufacturerName: '_TZ3040_bb6xaihh'}],
        model: 'TS0202_1',
        vendor: 'TuYa',
        description: 'Motion sensor',
        // Requires alarm_1_with_timeout https://github.com/Koenkk/zigbee2mqtt/issues/2818#issuecomment-776119586
        fromZigbee: [fz.ias_occupancy_alarm_1_with_timeout, fz.battery, fz.ignore_basic_report],
        toZigbee: [],
        exposes: [e.occupancy(), e.battery_low(), e.linkquality(), e.battery(), e.battery_voltage()],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            await reporting.batteryPercentageRemaining(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS0202', manufacturerName: '_TYZB01_dr6sduka'},
            {modelID: 'TS0202', manufacturerName: '_TYZB01_ef5xlc9q'},
            {modelID: 'TS0202', manufacturerName: '_TYZB01_2b8f6cio'},
            {modelID: 'TS0202', manufacturerName: '_TYZB01_71kfvvma'},
            {modelID: 'TS0202', manufacturerName: '_TZE200_bq5c8xfe'},
            {modelID: 'TS0202', manufacturerName: '_TYZB01_dl7cejts'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_nss8amz9'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_mmtwjmaq'},
            {modelID: 'TS0202', manufacturerName: '_TYZB01_zwvaj5wy'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_bsvqrxru'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_wrgn6xrz'},
            {modelID: 'TS0202', manufacturerName: '_TYZB01_tv3wxhcz'},
            {modelID: 'TS0202', manufacturerName: '_TYZB01_rwb0hxtf'},
            {modelID: 'TS0202', manufacturerName: '_TYZB01_hqbdru35'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_otvn3lne'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_tiwq83wk'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_ykwcwxmz'},
            // _TZ3000_kmh5qpmb = NAS-PD07 without temperature/humidity sensor
            // https://github.com/Koenkk/zigbee2mqtt/issues/15481#issuecomment-1366003011
            {modelID: 'TS0202', manufacturerName: '_TZ3000_kmh5qpmb'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_hgu1dlak'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_h4wnrtck'},
            {modelID: 'TS0202', manufacturerName: '_TZ3000_sr0vaafi'},
            {modelID: 'WHD02', manufacturerName: '_TZ3000_hktqahrq'},
            {modelID: 'TS0202', manufacturerName: '_TZ3040_wqmtjsyk'},
        ],
        model: 'TS0202',
        vendor: 'TuYa',
        description: 'Motion sensor',
        whiteLabel: [{vendor: 'Mercator Ikuü', model: 'SMA02P'},
            {vendor: 'TuYa', model: 'TY-ZPR06'},
            {vendor: 'Tesla Smart', model: 'TS0202'},
            tuya.whitelabel('MiBoxer', 'PIR1-ZB', 'PIR sensor', ['_TZ3040_wqmtjsyk']),
            tuya.whitelabel('TuYa', 'ZMS01', 'Motion sensor', ['_TZ3000_otvn3lne']),
        ],
        fromZigbee: [fz.ias_occupancy_alarm_1, fz.battery, fz.ignore_basic_report, fz.ias_occupancy_alarm_1_report],
        toZigbee: [],
        exposes: [e.occupancy(), e.battery_low(), e.tamper(), e.battery(), e.battery_voltage()],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            try {
                await reporting.batteryPercentageRemaining(endpoint);
                await reporting.batteryVoltage(endpoint);
            } catch (error) {/* Fails for some https://github.com/Koenkk/zigbee2mqtt/issues/13708*/}
        },
    },
    {
        fingerprint: [{modelID: 'TS0202', manufacturerName: '_TZ3000_msl6wxk9'}, {modelID: 'TS0202', manufacturerName: '_TZ3040_fwxuzcf4'}],
        model: 'ZM-35H-Q',
        vendor: 'TuYa',
        description: 'Motion sensor',
        fromZigbee: [fz.ias_occupancy_alarm_1, fz.battery, fz.ignore_basic_report, fz.ZM35HQ_attr, fzLocal.ZM35HQ_battery],
        toZigbee: [tz.ZM35HQ_attr],
        exposes: [e.occupancy(), e.battery_low(), e.tamper(), e.battery(),
            exposes.enum('sensitivity', ea.ALL, ['low', 'medium', 'high']).withDescription('PIR sensor sensitivity'),
            exposes.enum('keep_time', ea.ALL, [30, 60, 120]).withDescription('PIR keep time in seconds'),
        ],
        configure: tuya.configureMagicPacket,
    },
    {
        fingerprint: [{modelID: 'TS0202', manufacturerName: '_TZ3040_msl6wxk9'}],
        model: '40ZH-O',
        vendor: 'TuYa',
        description: 'Motion sensor',
        fromZigbee: [fz.ias_occupancy_alarm_1, fz.battery, fz.ignore_basic_report, fz.ZM35HQ_attr, fzLocal.ZM35HQ_battery],
        toZigbee: [tz.ZM35HQ_attr],
        exposes: [e.occupancy(), e.battery_low(), e.tamper(), e.battery(),
            exposes.enum('sensitivity', ea.ALL, ['low', 'medium', 'high']).withDescription('PIR sensor sensitivity'),
            exposes.enum('keep_time', ea.ALL, [30, 60, 120]).withDescription('PIR keep time in seconds'),
        ],
        configure: tuya.configureMagicPacket,
    },
    {
        fingerprint: tuya.fingerprint('TS0202', ['_TZ3000_mcxw5ehu', '_TZ3000_6ygjfyll', '_TZ3040_6ygjfyll']),
        model: 'IH012-RT01',
        vendor: 'TuYa',
        description: 'Motion sensor',
        fromZigbee: [fz.ias_occupancy_alarm_1, fz.ignore_basic_report, fz.ZM35HQ_attr, fz.battery],
        toZigbee: [tz.ZM35HQ_attr],
        exposes: [e.occupancy(), e.battery_low(), e.tamper(), e.battery(), e.battery_voltage(),
            exposes.enum('sensitivity', ea.ALL, ['low', 'medium', 'high']).withDescription('PIR sensor sensitivity'),
            exposes.enum('keep_time', ea.ALL, [30, 60, 120]).withDescription('PIR keep time in seconds'),
        ],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            await reporting.batteryPercentageRemaining(endpoint);
            await reporting.batteryVoltage(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS0207', manufacturerName: '_TZ3000_m0vaazab'},
            {modelID: 'TS0207', manufacturerName: '_TZ3000_ufttklsz'},
            {modelID: 'TS0207', manufacturerName: '_TZ3000_nkkl7uzv'},
            {modelID: 'TS0207', manufacturerName: '_TZ3000_misw04hq'},
            {modelID: 'TS0207', manufacturerName: '_TZ3000_gszjt2xx'},
            {modelID: 'TS0207', manufacturerName: '_TZ3000_5k5vh43t'}],
        model: 'TS0207_repeater',
        vendor: 'TuYa',
        description: 'Repeater',
        fromZigbee: [fz.linkquality_from_basic],
        toZigbee: [],
        exposes: [],
    },
    {
        zigbeeModel: ['TS0207', 'FNB54-WTS08ML1.0'],
        fingerprint: [{modelID: 'TS0207', manufacturerName: '_TZ3000_upgcbody'}],
        model: 'TS0207_water_leak_detector',
        vendor: 'TuYa',
        description: 'Water leak detector',
        fromZigbee: [fz.ias_water_leak_alarm_1, fz.battery],
        whiteLabel: [{vendor: 'CR Smart Home', model: 'TS0207'}],
        toZigbee: [],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            await reporting.batteryPercentageRemaining(endpoint);
        },
        exposes: [e.water_leak(), e.battery_low(), e.battery()],
    },
    {
        fingerprint: tuya.fingerprint('TS0101', ['_TYZB01_ijihzffk', '_TZ3210_tfxwxklq']),
        model: 'TS0101',
        vendor: 'TuYa',
        description: 'Zigbee Socket',
        whiteLabel: [{vendor: 'Larkkey', model: 'PS080'}, {vendor: 'Mercator', model: 'SPBS01G'}],
        extend: tuya.extend.switch(),
        meta: {disableDefaultResponse: true},
    },
    {
        fingerprint: [{modelID: 'TS0108', manufacturerName: '_TYZB01_7yidyqxd'}],
        model: 'TS0108',
        vendor: 'TuYa',
        description: 'Socket with 2 USB',
        whiteLabel: [{vendor: 'Larkkey', model: 'PS580'}],
        extend: tuya.extend.switch(),
        exposes: [e.switch().withEndpoint('l1'), e.switch().withEndpoint('l2')],
        endpoint: (device) => {
            return {'l1': 1, 'l2': 7};
        },
        meta: {multiEndpoint: true, disableDefaultResponse: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(7), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        fingerprint: [
            {modelID: 'TS0601', manufacturerName: '_TZE200_whpb9yts'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_ebwgzdqq'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_ctq0k47x'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_9i9dt8is'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_dfxkcots'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_w4cryh2i'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_ojzhk75b'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_swaamsoy'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_3p5ydos3'},
        ],
        model: 'TS0601_dimmer',
        vendor: 'TuYa',
        description: 'Zigbee smart dimmer',
        fromZigbee: [fz.tuya_dimmer, fz.ignore_basic_report],
        toZigbee: [tz.tuya_dimmer_state, tz.tuya_dimmer_level],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'genLevelCtrl']);
        },
        exposes: [e.light_brightness().withMinBrightness().withMaxBrightness().setAccess(
            'state', ea.STATE_SET).setAccess('brightness', ea.STATE_SET).setAccess(
            'min_brightness', ea.STATE_SET).setAccess('max_brightness', ea.STATE_SET)],
        whiteLabel: [
            {vendor: 'Larkkey', model: 'ZSTY-SM-1DMZG-EU'},
            {vendor: 'Earda', model: 'EDM-1ZAA-EU'},
            {vendor: 'Earda', model: 'EDM-1ZAB-EU'},
            {vendor: 'Earda', model: 'EDM-1ZBA-EU'},
            {vendor: 'Mercator Ikuü', model: 'SSWD01'},
            {vendor: 'Moes', model: 'ZS-USD'},
            {vendor: 'Moes', model: 'EDM-1ZBB-EU'},
        ],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_myd45weu']),
        model: 'TS0601_soil',
        vendor: 'TuYa',
        description: 'Soil sensor',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [e.temperature(), e.soil_moisture(), tuya.exposes.temperatureUnit(), e.battery(), tuya.exposes.batteryState()],
        meta: {
            tuyaDatapoints: [
                [3, 'soil_moisture', tuya.valueConverter.raw],
                [5, 'temperature', tuya.valueConverter.raw],
                [9, 'temperature_unit', tuya.valueConverter.temperatureUnit],
                [14, 'battery_state', tuya.valueConverter.batteryState],
                [15, 'battery', tuya.valueConverter.raw],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_ip2akl4w', '_TZE200_1agwnems', '_TZE200_la2c2uo9', '_TZE200_579lguh2',
            '_TZE200_vucankjx', '_TZE200_4mh6tyyo']),
        model: 'TS0601_dimmer_1',
        vendor: 'TuYa',
        description: '1 gang smart dimmer',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [tuya.exposes.lightBrightnessWithMinMax(), e.power_on_behavior(),
            tuya.exposes.countdown(), tuya.exposes.lightType()],
        meta: {
            tuyaDatapoints: [
                [1, 'state', tuya.valueConverter.onOff, {skip: tuya.skip.stateOnAndBrightnessPresent}],
                [2, 'brightness', tuya.valueConverter.scale0_254to0_1000],
                [3, 'min_brightness', tuya.valueConverter.scale0_254to0_1000],
                [4, 'light_type', tuya.valueConverter.lightType],
                [5, 'max_brightness', tuya.valueConverter.scale0_254to0_1000],
                [6, 'countdown', tuya.valueConverter.countdown],
                [14, 'power_on_behavior', tuya.valueConverter.powerOnBehavior],
            ],
        },
        whiteLabel: [
            {vendor: 'Moes', model: 'MS-105Z'},
            {vendor: 'Lerlink', model: 'X706U'},
            {vendor: 'Moes', model: 'ZS-EUD_1gang'},
        ],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_fjjbhx9d', '_TZE200_e3oitdyu', '_TZE200_gwkapsoq']),
        model: 'TS0601_dimmer_2',
        vendor: 'TuYa',
        description: '2 gang smart dimmer',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [
            tuya.exposes.lightBrightnessWithMinMax().withEndpoint('l1'),
            tuya.exposes.lightBrightnessWithMinMax().withEndpoint('l2'),
            tuya.exposes.countdown().withEndpoint('l1'),
            tuya.exposes.countdown().withEndpoint('l2'),
        ],
        meta: {
            multiEndpoint: true,
            tuyaDatapoints: [
                [1, 'state_l1', tuya.valueConverter.onOff, {skip: tuya.skip.stateOnAndBrightnessPresent}],
                [2, 'brightness_l1', tuya.valueConverter.scale0_254to0_1000],
                [3, 'min_brightness_l1', tuya.valueConverter.scale0_254to0_1000],
                [5, 'max_brightness_l1', tuya.valueConverter.scale0_254to0_1000],
                [6, 'countdown_l1', tuya.valueConverter.countdown],
                [7, 'state_l2', tuya.valueConverter.onOff, {skip: tuya.skip.stateOnAndBrightnessPresent}],
                [8, 'brightness_l2', tuya.valueConverter.scale0_254to0_1000],
                [9, 'min_brightness_l2', tuya.valueConverter.scale0_254to0_1000],
                [11, 'max_brightness_l2', tuya.valueConverter.scale0_254to0_1000],
                [12, 'countdown_l2', tuya.valueConverter.countdown],
            ],
        },
        endpoint: (device) => {
            return {'l1': 1, 'l2': 1};
        },
        whiteLabel: [
            {vendor: 'Moes', model: 'ZS-EUD_2gang'},
            {vendor: 'Moes', model: 'MS-105B'}, // _TZE200_e3oitdyu
        ],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_vm1gyrso']),
        model: 'TS0601_dimmer_3',
        vendor: 'TuYa',
        description: '3 gang smart dimmer',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [tuya.exposes.lightBrightness().withEndpoint('l1'), tuya.exposes.lightBrightness().withEndpoint('l2'),
            tuya.exposes.lightBrightness().withEndpoint('l3')],
        meta: {
            multiEndpoint: true,
            tuyaDatapoints: [
                [1, 'state_l1', tuya.valueConverter.onOff, {skip: tuya.skip.stateOnAndBrightnessPresent}],
                [2, 'brightness_l1', tuya.valueConverter.scale0_254to0_1000],
                [7, 'state_l2', tuya.valueConverter.onOff, {skip: tuya.skip.stateOnAndBrightnessPresent}],
                [8, 'brightness_l2', tuya.valueConverter.scale0_254to0_1000],
                [15, 'state_l3', tuya.valueConverter.onOff, {skip: tuya.skip.stateOnAndBrightnessPresent}],
                [16, 'brightness_l3', tuya.valueConverter.scale0_254to0_1000],
            ],
        },
        endpoint: (device) => {
            return {'l1': 1, 'l2': 1, 'l3': 1};
        },
        whiteLabel: [
            {vendor: 'Moes', model: 'ZS-EUD_3gang'},
        ],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_p0gzbqct']),
        model: 'TS0601_dimmer_knob',
        vendor: 'TuYa',
        description: 'Zigbee smart knob dimmer',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [tuya.exposes.lightBrightness().withMinBrightness().setAccess('min_brightness', ea.STATE_SET), tuya.exposes.lightType(),
            tuya.exposes.indicatorModeNoneRelayPos()],
        meta: {
            tuyaDatapoints: [
                [1, 'state', tuya.valueConverter.onOff, {skip: tuya.skip.stateOnAndBrightnessPresent}],
                [2, 'brightness', tuya.valueConverter.scale0_254to0_1000],
                [3, 'min_brightness', tuya.valueConverter.scale0_254to0_1000],
                [4, 'light_type', tuya.valueConverter.lightType],
                [21, 'indicator_mode', tuya.valueConverterBasic.lookup({0: 'none', 1: 'relay', 2: 'pos'})],
            ],
        },
        whiteLabel: [
            {vendor: 'Moes', model: 'WS-SY-EURD'},
            {vendor: 'Moes', model: 'WS-SY-EURD-WH-MS'},
        ],
    },
    {
        fingerprint: [{modelID: 'TS011F', manufacturerName: '_TZ3000_oiymh3qu'}],
        model: 'TS011F_socket_module',
        vendor: 'TuYa',
        description: 'Socket module',
        extend: tuya.extend.switch(),
        whiteLabel: [{vendor: 'LoraTap', model: 'RR400ZB'}, {vendor: 'LoraTap', model: 'SP400ZB'}],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
            await reporting.onOff(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS011F', manufacturerName: '_TZ3000_wxtp7c5y'},
            {modelID: 'TS011F', manufacturerName: '_TYZB01_mtunwanm'},
            {modelID: 'TS011F', manufacturerName: '_TZ3000_o1jzcxou'}],
        model: 'TS011F_wall_outlet',
        vendor: 'TuYa',
        description: 'In-wall outlet',
        extend: tuya.extend.switch(),
        whiteLabel: [{vendor: 'Teekar', model: 'SWP86-01OG'},
            {vendor: 'ClickSmart+', model: 'CMA30035'},
            {vendor: 'BSEED', model: 'Zigbee Socket'}],
    },
    {
        fingerprint: [{modelID: 'isltm67\u0000', manufacturerName: '_TYST11_pisltm67'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_pisltm67'}],
        model: 'S-LUX-ZB',
        vendor: 'TuYa',
        description: 'Light sensor',
        fromZigbee: [fz.SLUXZB],
        toZigbee: [],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genBasic']);
        },
        exposes: [e.battery(), e.illuminance_lux(), e.linkquality(),
            exposes.enum('brightness_level', ea.STATE, ['LOW', 'MEDIUM', 'HIGH'])],
    },
    {
        zigbeeModel: ['TS130F'],
        model: 'TS130F',
        vendor: 'TuYa',
        description: 'Curtain/blind switch',
        fromZigbee: [fz.cover_position_tilt, tuya.fz.backlight_mode_low_medium_high, fz.tuya_cover_options],
        toZigbee: [tz.cover_state, tz.cover_position_tilt, tz.tuya_cover_calibration, tz.tuya_cover_reversal,
            tuya.tz.backlight_indicator_mode_1],
        meta: {coverInverted: true},
        whiteLabel: [
            {vendor: 'LoraTap', model: 'SC400'},
            tuya.whitelabel('Zemismart', 'ZN-LC1E', 'Smart curtain/shutter switch', ['_TZ3000_74hsp7qy']),
        ],
        exposes: [e.cover_position(), exposes.enum('moving', ea.STATE, ['UP', 'STOP', 'DOWN']),
            exposes.binary('calibration', ea.ALL, 'ON', 'OFF'), exposes.binary('motor_reversal', ea.ALL, 'ON', 'OFF'),
            exposes.enum('backlight_mode', ea.ALL, ['low', 'medium', 'high']),
            exposes.numeric('calibration_time', ea.STATE).withUnit('S').withDescription('Calibration time')],
    },
    {
        zigbeeModel: ['qnazj70', 'kjintbl'],
        fingerprint: [
            {modelID: 'TS0601', manufacturerName: '_TZE200_wunufsil'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_vhy3iakz'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_oisqyl4o'},
            {modelID: 'TS0601', manufacturerName: '_TZ3000_uim07oem'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_js3mgbjb'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_7deq70b8'},
        ],
        model: 'TS0601_switch',
        vendor: 'TuYa',
        description: '1, 2, 3 or 4 gang switch',
        exposes: [e.switch().withEndpoint('l1').setAccess('state', ea.STATE_SET),
            e.switch().withEndpoint('l2').setAccess('state', ea.STATE_SET),
            e.switch().withEndpoint('l3').setAccess('state', ea.STATE_SET), e.switch().withEndpoint('l4').setAccess('state', ea.STATE_SET)],
        fromZigbee: [fz.ignore_basic_report, fz.tuya_switch],
        toZigbee: [tz.tuya_switch_state],
        meta: {multiEndpoint: true},
        whiteLabel: [
            {vendor: 'Norklmes', model: 'MKS-CM-W5'},
            {vendor: 'Somgoms', model: 'ZSQB-SMB-ZB'},
            {vendor: 'Moes', model: 'WS-EUB1-ZG'},
            {vendor: 'AVATTO', model: 'ZGB-WS-EU'},
        ],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            if (device.getEndpoint(2)) await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            if (device.getEndpoint(3)) await reporting.bind(device.getEndpoint(3), coordinatorEndpoint, ['genOnOff']);
            if (device.getEndpoint(4)) await reporting.bind(device.getEndpoint(4), coordinatorEndpoint, ['genOnOff']);
        },
        endpoint: (device) => {
            // Endpoint selection is made in tuya_switch_state
            return {'l1': 1, 'l2': 1, 'l3': 1, 'l4': 1};
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_aqnazj70', '_TZE200_k6jhsr0q', '_TZE200_di3tfv5b', '_TZE200_mexisfik']),
        model: 'TS0601_switch_4_gang',
        vendor: 'TuYa',
        description: '4 gang switch',
        exposes: [e.switch().withEndpoint('l1').setAccess('state', ea.STATE_SET),
            e.switch().withEndpoint('l2').setAccess('state', ea.STATE_SET),
            e.switch().withEndpoint('l3').setAccess('state', ea.STATE_SET),
            e.switch().withEndpoint('l4').setAccess('state', ea.STATE_SET)],
        fromZigbee: [fz.ignore_basic_report, fz.tuya_switch],
        toZigbee: [tz.tuya_switch_state],
        meta: {multiEndpoint: true},
        endpoint: (device) => {
            // Endpoint selection is made in tuya_switch_state
            return {'l1': 1, 'l2': 1, 'l3': 1, 'l4': 1};
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_jwsjbxjs']),
        model: 'TS0601_switch_5_gang',
        vendor: 'TuYa',
        description: '5 gang switch',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [
            tuya.exposes.switch().withEndpoint('l1'),
            tuya.exposes.switch().withEndpoint('l2'),
            tuya.exposes.switch().withEndpoint('l3'),
            tuya.exposes.switch().withEndpoint('l4'),
            tuya.exposes.switch().withEndpoint('l5'),
        ],
        endpoint: (device) => {
            return {'l1': 1, 'l2': 1, 'l3': 1, 'l4': 1, 'l5': 1};
        },
        meta: {
            multiEndpoint: true,
            tuyaDatapoints: [
                [1, 'state_l1', tuya.valueConverter.onOff],
                [2, 'state_l2', tuya.valueConverter.onOff],
                [3, 'state_l3', tuya.valueConverter.onOff],
                [4, 'state_l4', tuya.valueConverter.onOff],
                [5, 'state_l5', tuya.valueConverter.onOff],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_mwvfvw8g']),
        model: 'TS0601_switch_6_gang',
        vendor: 'TuYa',
        description: '6 gang switch',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [
            tuya.exposes.switch().withEndpoint('l1'),
            tuya.exposes.switch().withEndpoint('l2'),
            tuya.exposes.switch().withEndpoint('l3'),
            tuya.exposes.switch().withEndpoint('l4'),
            tuya.exposes.switch().withEndpoint('l5'),
            tuya.exposes.switch().withEndpoint('l6'),
        ],
        endpoint: (device) => {
            return {'l1': 1, 'l2': 1, 'l3': 1, 'l4': 1, 'l5': 1, 'l6': 1};
        },
        meta: {
            multiEndpoint: true,
            tuyaDatapoints: [
                [1, 'state_l1', tuya.valueConverter.onOff],
                [2, 'state_l2', tuya.valueConverter.onOff],
                [3, 'state_l3', tuya.valueConverter.onOff],
                [4, 'state_l4', tuya.valueConverter.onOff],
                [5, 'state_l5', tuya.valueConverter.onOff],
                [6, 'state_l6', tuya.valueConverter.onOff],
            ],
        },
    },
    {
        fingerprint: [
            {modelID: 'TS0601', manufacturerName: '_TZE200_nkjintbl'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_ji1gn7rw'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_3t91nb6k'},
        ],
        model: 'TS0601_switch_2_gang',
        vendor: 'TuYa',
        description: '2 gang switch',
        exposes: [e.switch().withEndpoint('l1').setAccess('state', ea.STATE_SET),
            e.switch().withEndpoint('l2').setAccess('state', ea.STATE_SET)],
        fromZigbee: [fz.ignore_basic_report, fz.tuya_switch],
        toZigbee: [tz.tuya_switch_state],
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            if (device.getEndpoint(2)) await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
        },
        endpoint: (device) => {
            // Endpoint selection is made in tuya_switch_state
            return {'l1': 1, 'l2': 1};
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_kyfqmmyl'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_2hf7x9n3'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_bynnczcb'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_atpwqgml'}],
        model: 'TS0601_switch_3_gang',
        vendor: 'TuYa',
        description: '3 gang switch',
        whiteLabel: [{vendor: 'NOVADIGITAL', model: 'WS-US-ZB', description: 'Interruptor touch Zigbee 3 Teclas'}],
        exposes: [e.switch().withEndpoint('l1').setAccess('state', ea.STATE_SET),
            e.switch().withEndpoint('l2').setAccess('state', ea.STATE_SET),
            e.switch().withEndpoint('l3').setAccess('state', ea.STATE_SET)],
        fromZigbee: [fz.ignore_basic_report, fz.tuya_switch],
        toZigbee: [tz.tuya_switch_state],
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
        },
        endpoint: (device) => {
            // Endpoint selection is made in tuya_switch_state
            return {'l1': 1, 'l2': 1, 'l3': 1};
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0215A', ['_TZ3000_4fsgukof', '_TZ3000_wr2ucaj9', '_TZ3000_zsh6uat3', '_TZ3000_tj4pwzzm',
            '_TZ3000_2izubafb', '_TZ3000_pkfazisv']),
        model: 'TS0215A_sos',
        vendor: 'TuYa',
        description: 'SOS button',
        fromZigbee: [fz.command_emergency, fz.battery],
        exposes: [e.battery(), e.battery_voltage(), e.action(['emergency'])],
        toZigbee: [],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg', 'genTime', 'genBasic', 'ssIasAce', 'ssIasZone']);
            await reporting.batteryPercentageRemaining(endpoint);
            await reporting.batteryVoltage(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS0215A', manufacturerName: '_TZ3000_p6ju8myv'},
            {modelID: 'TS0215A', manufacturerName: '_TZ3000_0zrccfgx'},
            {modelID: 'TS0215A', manufacturerName: '_TZ3000_fsiepnrh'},
            {modelID: 'TS0215A', manufacturerName: '_TZ3000_ug1vtuzn'}],
        model: 'TS0215A_remote',
        vendor: 'TuYa',
        description: 'Security remote control',
        fromZigbee: [fz.command_arm, fz.command_emergency, fz.battery],
        exposes: [e.battery(), e.action(['disarm', 'arm_day_zones', 'arm_night_zones', 'arm_all_zones', 'exit_delay', 'emergency'])],
        toZigbee: [],
        whiteLabel: [{vendor: 'Woox', model: 'R7054'}, {vendor: 'Nedis', model: 'ZBRC10WT'}],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg', 'genTime', 'genBasic', 'ssIasAce', 'ssIasZone']);
        },
    },
    {
        fingerprint: [{modelID: 'TS0503A', manufacturerName: '_TZ3000_obacbukl'}],
        model: 'TS0503A',
        vendor: 'TuYa',
        description: 'Led strip controller',
        extend: tuya.extend.light_onoff_brightness_color(),
    },
    {
        zigbeeModel: ['TS0503A'],
        model: 'TYZS1L',
        vendor: 'TuYa',
        description: 'Led strip controller HSB',
        exposes: [e.light_colorhs()],
        fromZigbee: [fz.on_off, fz.tuya_led_controller],
        toZigbee: [tz.tuya_led_controller, tz.ignore_transition, tz.ignore_rate],
    },
    {
        zigbeeModel: ['TS0502A'],
        model: 'TS0502A',
        vendor: 'TuYa',
        description: 'Light controller',
        extend: tuya.extend.light_onoff_brightness_colortemp({colorTempRange: [153, 500], noConfigure: true}),
        whiteLabel: [
            tuya.whitelabel('Lidl', 'HG06492B', 'Livarno Lux E14 candle CCT', ['_TZ3000_oborybow']),
            tuya.whitelabel('Lidl', 'HG06492A', 'Livarno Lux GU10 spot CCT', ['_TZ3000_el5kt5im']),
            tuya.whitelabel('Lidl', 'HG06492C', 'Livarno Lux E27 bulb CCT', ['_TZ3000_49qchf10']),
            tuya.whitelabel('Lidl', '14147206L', 'Livarno Lux ceiling light', ['_TZ3000_rylaozuc', '_TZ3000_5fkufhn1']),
            tuya.whitelabel('Lidl', '14153905L', 'Livarno Home LED floor lamp', ['_TZ3000_8uaoilu9']),
        ],
        configure: async (device, coordinatorEndpoint, logger) => {
            device.getEndpoint(1).saveClusterAttributeKeyValue('lightingColorCtrl', {colorCapabilities: 16});
        },
    },
    {
        zigbeeModel: ['TS0502B'],
        model: 'TS0502B',
        vendor: 'TuYa',
        description: 'Light controller',
        whiteLabel: [
            {vendor: 'Mercator Ikuü', model: 'SMI7040', description: 'Ford Batten Light'},
            {vendor: 'Mercator Ikuü', model: 'SMD9300', description: 'Donovan Panel Light'},
            tuya.whitelabel('Aldi', 'F122SB62H22A4.5W', 'LIGHTWAY smart home LED-lamp - filament', ['_TZ3000_g1glzzfk']),
            tuya.whitelabel('Miboxer', 'FUT035Z', 'Dual white LED controller', ['_TZ3210_frm6149r', '_TZ3210_jtifm80b', '_TZ3210_xwqng7ol']),
            tuya.whitelabel('Lidl', '14156408L', 'Livarno Lux smart LED ceiling light', ['_TZ3210_c2iwpxf1']),
        ],
        extend: tuya.extend.light_onoff_brightness_colortemp({colorTempRange: [153, 500], noConfigure: true}),
        configure: async (device, coordinatorEndpoint, logger) => {
            device.getEndpoint(1).saveClusterAttributeKeyValue('lightingColorCtrl', {colorCapabilities: 16});
        },
    },
    {
        zigbeeModel: ['TS0504A'],
        model: 'TS0504A',
        vendor: 'TuYa',
        description: 'RGBW LED controller',
        extend: tuya.extend.light_onoff_brightness_colortemp_color(),
    },
    {
        fingerprint: [{modelID: 'TS0505A', manufacturerName: '_TZ3000_sosdczdl'}],
        model: 'TS0505A_led',
        vendor: 'TuYa',
        description: 'RGB+CCT LED',
        toZigbee: [tz.on_off, tz.tuya_led_control],
        fromZigbee: [fz.on_off, fz.tuya_led_controller, fz.brightness, fz.ignore_basic_report],
        exposes: [e.light_brightness_colortemp_colorhs([153, 500]).removeFeature('color_temp_startup')],
    },
    {
        zigbeeModel: ['TS0505A'],
        model: 'TS0505A',
        vendor: 'TuYa',
        description: 'RGB+CCT light controller',
        extend: tuya.extend.light_onoff_brightness_colortemp_color({noConfigure: true}),
        whiteLabel: [
            tuya.whitelabel('Lidl', 'HG06106B', 'Livarno Lux E14 candle RGB', ['_TZ3000_odygigth']),
            tuya.whitelabel('Lidl', 'HG06106A', 'Livarno Lux GU10 spot RGB', ['_TZ3000_kdpxju99']),
            tuya.whitelabel('Lidl', 'HG06106C', 'Livarno Lux E27 bulb RGB', ['_TZ3000_dbou1ap4']),
            tuya.whitelabel('Lidl', '14148906L', 'Livarno Lux mood light RGB+CCT', ['_TZ3000_9cpuaca6']),
            tuya.whitelabel('Lidl', '14149505L/14149506L_1', 'Livarno Lux light bar RGB+CCT (black/white)', ['_TZ3000_gek6snaj']),
            tuya.whitelabel('Mycket', 'MS-SP-LE27WRGB', 'E27 RGBW bulb', ['_TZ3000_evag0pvn']),
            tuya.whitelabel('Lidl', 'HG06104A', 'Livarno Lux smart LED light strip 2.5m', ['_TZ3000_riwp3k79', '_TZ3000_riwp3k79']),
        ],
        configure: async (device, coordinatorEndpoint, logger) => {
            device.getEndpoint(1).saveClusterAttributeKeyValue('lightingColorCtrl', {colorCapabilities: 29});
        },
    },
    {
        fingerprint: [{manufacturerName: '_TZ2000_a476raq2'}],
        zigbeeModel: ['TS0201', 'SNTZ003'],
        model: 'TS0201',
        vendor: 'TuYa',
        description: 'Temperature & humidity sensor with display',
        whiteLabel: [{vendor: 'BlitzWolf', model: 'BW-IS4'}],
        fromZigbee: [fzLocal.TS0201_battery, fz.temperature, fzLocal.TS0201_humidity],
        toZigbee: [],
        exposes: [e.battery(), e.temperature(), e.humidity(), e.battery_voltage()],
        configure: tuya.configureMagicPacket,
    },
    {
        fingerprint: [
            {modelID: 'TS0201', manufacturerName: '_TZ3000_bguser20'},
            {modelID: 'TS0201', manufacturerName: '_TZ3000_fllyghyj'},
            {modelID: 'TS0201', manufacturerName: '_TZ3000_yd2e749y'},
            {modelID: 'TS0201', manufacturerName: '_TZ3000_6uzkisv2'},
            {modelID: 'TS0201', manufacturerName: '_TZ3000_xr3htd96'},
        ],
        model: 'WSD500A',
        vendor: 'TuYa',
        description: 'Temperature & humidity sensor',
        fromZigbee: [fzLocal.TS0201_battery, fz.temperature, fz.humidity],
        toZigbee: [],
        exposes: [e.battery(), e.temperature(), e.humidity(), e.battery_voltage()],
        configure: tuya.configureMagicPacket,
    },
    {
        fingerprint: tuya.fingerprint('TS0201', ['_TZ3000_dowj6gyi', '_TZ3000_8ybe88nf']),
        model: 'IH-K009',
        vendor: 'TuYa',
        description: 'Temperature & humidity sensor',
        fromZigbee: [fzLocal.TS0201_battery, fz.temperature, fz.humidity],
        toZigbee: [],
        exposes: [e.battery(), e.temperature(), e.humidity(), e.battery_voltage()],
        configure: tuya.configureMagicPacket,
    },
    {
        fingerprint: tuya.fingerprint('SM0201', ['_TYZB01_cbiezpds', '_TYZB01_zqvwka4k']),
        model: 'SM0201',
        vendor: 'TuYa',
        description: 'Temperature & humidity sensor with LED screen',
        fromZigbee: [fz.battery, fz.temperature, fz.humidity],
        toZigbee: [],
        exposes: [e.battery(), e.temperature(), e.humidity(), e.battery_voltage()],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_yjjdcqsq']),
        model: 'ZTH01',
        vendor: 'TuYa',
        description: 'Temperature and humidity sensor',
        fromZigbee: [tuya.fz.datapoints, tuya.fz.gateway_connection_status],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [e.temperature(), e.humidity(), tuya.exposes.batteryState(), e.battery_low()],
        meta: {
            tuyaDatapoints: [
                [1, 'temperature', tuya.valueConverter.divideBy10],
                [2, 'humidity', tuya.valueConverter.raw],
                [3, 'battery_state', tuya.valueConverter.batteryState],
                // [9, 'temperature_unit', tuya.valueConverter.raw], This DP is not properly supported by the device
            ],
        },
    },
    {
        fingerprint: [{modelID: 'TS011F', manufacturerName: '_TZ3000_3zofvcaa'}],
        model: 'TS011F_2_gang_2_usb_wall',
        vendor: 'TuYa',
        description: '2 gang 2 usb wall outlet',
        extend: tuya.extend.switch({backlightModeLowMediumHigh: true, endpoints: ['l1', 'l2', 'l3', 'l4']}),
        endpoint: () => {
            return {'l1': 1, 'l2': 2, 'l3': 3, 'l4': 4};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            for (const endpointID of [1, 2, 3, 4]) {
                const endpoint = device.getEndpoint(endpointID);
                await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
                await reporting.onOff(endpoint);
            }
        },
    },
    {
        zigbeeModel: ['TS0041'],
        fingerprint: [{manufacturerName: '_TZ3000_tk3s5tyg'}],
        model: 'TS0041',
        vendor: 'TuYa',
        description: 'Wireless switch with 1 button',
        whiteLabel: [{vendor: 'Smart9', model: 'S9TSZGB'}, {vendor: 'Lonsonho', model: 'TS0041'}, {vendor: 'Benexmart', model: 'ZM-sui1'}],
        exposes: [e.battery(), e.action(['single', 'double', 'hold'])],
        fromZigbee: [fz.tuya_on_off_action, fz.battery],
        toZigbee: [],
        configure: tuya.configureMagicPacket,
        /*
         * reporting.batteryPercentageRemaining removed as it was causing devices to fall of the network
         * every 1 hour, with light flashing when it happened, extremely short battery life, 2 presses for
         * action to register: https://github.com/Koenkk/zigbee2mqtt/issues/8072
         * Initially wrapped in a try catch: https://github.com/Koenkk/zigbee2mqtt/issues/6313
         */
    },
    {
        zigbeeModel: ['TS0042'],
        model: 'TS0042',
        vendor: 'TuYa',
        description: 'Wireless switch with 2 buttons',
        whiteLabel: [{vendor: 'Smart9', model: 'S9TSZGB'}, {vendor: 'Lonsonho', model: 'TS0042'},
            {vendor: 'ClickSmart+', model: 'CSPGM2075PW'}],
        exposes: [e.battery(), e.action(['1_single', '1_double', '1_hold', '2_single', '2_double', '2_hold'])],
        fromZigbee: [fz.tuya_on_off_action, fz.battery],
        toZigbee: [],
        configure: tuya.configureMagicPacket,
        /*
         * reporting.batteryPercentageRemaining removed as it was causing devices to fall of the network
         * every 1 hour, with light flashing when it happened, extremely short battery life, 2 presses for
         * action to register: https://github.com/Koenkk/zigbee2mqtt/issues/8072
         * Initially wrapped in a try catch: https://github.com/Koenkk/zigbee2mqtt/issues/6313
         */
    },
    {
        zigbeeModel: ['TS0043'],
        model: 'TS0043',
        vendor: 'TuYa',
        description: 'Wireless switch with 3 buttons',
        whiteLabel: [{vendor: 'Smart9', model: 'S9TSZGB'}, {vendor: 'Lonsonho', model: 'TS0043'}, {vendor: 'LoraTap', model: 'SS600ZB'}],
        exposes: [e.battery(),
            e.action(['1_single', '1_double', '1_hold', '2_single', '2_double', '2_hold', '3_single', '3_double', '3_hold'])],
        fromZigbee: [fz.tuya_on_off_action, fz.battery],
        toZigbee: [],
        configure: tuya.configureMagicPacket,
        /*
         * reporting.batteryPercentageRemaining removed as it was causing devices to fall of the network
         * every 1 hour, with light flashing when it happened, extremely short battery life, 2 presses for
         * action to register: https://github.com/Koenkk/zigbee2mqtt/issues/8072
         * Initially wrapped in a try catch: https://github.com/Koenkk/zigbee2mqtt/issues/6313
         */
    },
    {
        zigbeeModel: ['TS0044'],
        model: 'TS0044',
        vendor: 'TuYa',
        description: 'Wireless switch with 4 buttons',
        whiteLabel: [{vendor: 'Lonsonho', model: 'TS0044'}, {vendor: 'Haozee', model: 'ESW-OZAA-EU'},
            {vendor: 'LoraTap', model: 'SS6400ZB'}, {vendor: 'Moes', model: 'ZT-SY-EU-G-4S-WH-MS'}],
        fromZigbee: [fz.tuya_on_off_action, fz.battery],
        exposes: [e.battery(), e.action(['1_single', '1_double', '1_hold', '2_single', '2_double', '2_hold',
            '3_single', '3_double', '3_hold', '4_single', '4_double', '4_hold'])],
        toZigbee: [],
        configure: tuya.configureMagicPacket,
        /*
         * reporting.batteryPercentageRemaining removed as it was causing devices to fall of the network
         * every 1 hour, with light flashing when it happened, extremely short battery life, 2 presses for
         * action to register: https://github.com/Koenkk/zigbee2mqtt/issues/8072
         * Initially wrapped in a try catch: https://github.com/Koenkk/zigbee2mqtt/issues/6313
         */
    },
    {
        fingerprint: tuya.fingerprint('TS004F', ['_TZ3000_xabckq1v', '_TZ3000_czuyt8lz']),
        model: 'TS004F',
        vendor: 'TuYa',
        description: 'Wireless switch with 4 buttons',
        exposes: [e.battery(), e.action(['1_single', '1_double', '1_hold', '2_single', '2_double', '2_hold',
            '3_single', '3_double', '3_hold', '4_single', '4_double', '4_hold'])],
        fromZigbee: [fz.battery, fz.tuya_on_off_action],
        toZigbee: [tz.tuya_operation_mode],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await endpoint.read('genBasic', [0x0004, 0x000, 0x0001, 0x0005, 0x0007, 0xfffe]);
            await endpoint.write('genOnOff', {'tuyaOperationMode': 1});
            await endpoint.read('genOnOff', ['tuyaOperationMode']);
            try {
                await endpoint.read(0xE001, [0xD011]);
            } catch (err) {/* do nothing */}
            await endpoint.read('genPowerCfg', ['batteryVoltage', 'batteryPercentageRemaining']);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            for (const ep of [1, 2, 3, 4]) {
                // Not all variants have all endpoints
                // https://github.com/Koenkk/zigbee2mqtt/issues/15730#issuecomment-1364498358
                if (device.getEndpoint(ep)) {
                    await reporting.bind(device.getEndpoint(ep), coordinatorEndpoint, ['genOnOff']);
                }
            }
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_qq9mpfhw'}],
        model: 'TS0601_water_sensor',
        vendor: 'TuYa',
        description: 'Water leak sensor',
        fromZigbee: [fz.tuya_water_leak, fz.ignore_basic_report],
        exposes: [e.water_leak()],
        toZigbee: [],
        whiteLabel: [{vendor: 'Neo', model: 'NAS-WS02B0'}],
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_jthf7vb6'}],
        model: 'WLS-100z',
        vendor: 'TuYa',
        description: 'Water leak sensor',
        fromZigbee: [fz.ignore_basic_report, fz.ignore_tuya_raw, fz.wls100z_water_leak],
        toZigbee: [],
        onEvent: tuya.onEventSetTime,
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genBasic']);
        },
        exposes: [e.battery(), e.water_leak()],
    },
    {
        fingerprint: tuya.fingerprint('TS0001', ['_TZ3000_xkap8wtb', '_TZ3000_qnejhcsu', '_TZ3000_x3ewpzyr',
            '_TZ3000_mkhkxx1p', '_TZ3000_tgddllx4']),
        model: 'TS0001_power',
        description: 'Switch with power monitoring',
        vendor: 'TuYa',
        fromZigbee: [fz.on_off, fz.electrical_measurement, fz.metering, fz.ignore_basic_report,
            tuya.fz.power_outage_memory, tuya.fz.switch_type],
        toZigbee: [tz.on_off, tuya.tz.power_on_behavior_1, tuya.tz.switch_type],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'haElectricalMeasurement', 'seMetering']);
            await reporting.rmsVoltage(endpoint, {change: 5});
            await reporting.rmsCurrent(endpoint, {change: 50});
            await reporting.activePower(endpoint, {change: 10});
            await reporting.currentSummDelivered(endpoint);
            endpoint.saveClusterAttributeKeyValue('haElectricalMeasurement', {acCurrentDivisor: 1000, acCurrentMultiplier: 1});
            endpoint.saveClusterAttributeKeyValue('seMetering', {divisor: 100, multiplier: 1});
            device.save();
        },
        exposes: [e.switch(), e.power(), e.current(), e.voltage(), e.energy(), tuya.exposes.switchType(),
            exposes.enum('power_outage_memory', ea.ALL, ['on', 'off', 'restore']).withDescription('Recover state after power outage')],
    },
    {
        fingerprint: [{modelID: 'TS0002', manufacturerName: '_TZ3000_irrmjcgi'}],
        model: 'TS0002_power',
        vendor: 'TuYa',
        description: '2 gang switch with power monitoring',
        extend: tuya.extend.switch({switchType: true, endpoints: ['l1', 'l2'], electricalMeasurements: true}),
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2};
        },
        meta: {multiEndpoint: true, multiEndpointSkip: ['energy', 'current', 'voltage', 'power']},
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await endpoint.read('genBasic', ['manufacturerName', 'zclVersion', 'appVersion', 'modelId', 'powerSource', 0xfffe]);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'haElectricalMeasurement', 'seMetering']);
            await reporting.rmsVoltage(endpoint, {change: 5});
            await reporting.rmsCurrent(endpoint, {change: 50});
            await reporting.activePower(endpoint, {change: 10});
            await reporting.currentSummDelivered(endpoint);
            endpoint.saveClusterAttributeKeyValue('haElectricalMeasurement', {acCurrentDivisor: 1000, acCurrentMultiplier: 1});
            endpoint.saveClusterAttributeKeyValue('seMetering', {divisor: 100, multiplier: 1});
            device.save();
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        fingerprint: tuya.fingerprint('TS000F', ['_TZ3000_xkap8wtb']),
        model: 'TS000F_power',
        description: 'Switch with power monitoring',
        vendor: 'TuYa',
        fromZigbee: [fz.on_off, fz.electrical_measurement, fz.metering, fz.ignore_basic_report, tuya.fz.power_on_behavior_1,
            tuya.fz.switch_type],
        toZigbee: [tz.on_off, tuya.tz.power_on_behavior_1, tuya.tz.switch_type],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'haElectricalMeasurement', 'seMetering']);
            await reporting.rmsVoltage(endpoint, {change: 5});
            await reporting.rmsCurrent(endpoint, {change: 50});
            await reporting.currentSummDelivered(endpoint);
            endpoint.saveClusterAttributeKeyValue('seMetering', {divisor: 100, multiplier: 1});
            device.save();
        },
        whiteLabel: [{vendor: 'Aubess', model: 'WHD02'}],
        exposes: [e.switch(), e.power(), e.current(), e.voltage(), e.energy(), e.power_on_behavior(),
            tuya.exposes.switchType()],
    },
    {
        zigbeeModel: ['TS0001'],
        model: 'TS0001',
        vendor: 'TuYa',
        description: '1 gang switch',
        extend: tuya.extend.switch(),
        whiteLabel: [{vendor: 'CR Smart Home', model: 'TS0001', description: 'Valve control'}, {vendor: 'Lonsonho', model: 'X701'},
            {vendor: 'Bandi', model: 'BDS03G1'}],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        zigbeeModel: ['TS0002'],
        model: 'TS0002',
        vendor: 'TuYa',
        description: '2 gang switch',
        whiteLabel: [{vendor: 'Zemismart', model: 'ZM-CSW002-D_switch'}, {vendor: 'Lonsonho', model: 'X702'},
            {vendor: 'Avatto', model: 'ZTS02'}],
        extend: tuya.extend.switch(),
        exposes: [e.switch().withEndpoint('l1'), e.switch().withEndpoint('l2')],
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0001', ['_TZ3000_tqlv4ug4', '_TZ3000_gjrubzje', '_TZ3000_tygpxwqa']),
        model: 'TS0001_switch_module',
        vendor: 'TuYa',
        description: '1 gang switch module',
        whiteLabel: [{vendor: 'OXT', model: 'SWTZ21'}],
        extend: tuya.extend.switch({switchType: true}),
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0002', ['_TZ3000_01gpyda5', '_TZ3000_bvrlqyj7', '_TZ3000_7ed9cqgi',
            '_TZ3000_zmy4lslw', '_TZ3000_ruxexjfz', '_TZ3000_4xfqlgqo']),
        model: 'TS0002_switch_module',
        vendor: 'TuYa',
        description: '2 gang switch module',
        whiteLabel: [
            {vendor: 'OXT', model: 'SWTZ22'}, {vendor: 'Nous', model: 'L13Z'},
            tuya.whitelabel('pcblab.io', 'RR620ZB', '2 gang Zigbee switch module', ['_TZ3000_4xfqlgqo']),
        ],
        extend: tuya.extend.switch({switchType: true, endpoints: ['l1', 'l2']}),
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0002', ['_TZ3000_fisb3ajo', '_TZ3000_5gey1ohx']),
        model: 'TS0002_switch_module_2',
        vendor: 'TuYa',
        description: '2 gang switch module',
        extend: tuya.extend.switch({endpoints: ['l1', 'l2']}),
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        fingerprint: [{modelID: 'TS0003', manufacturerName: '_TZ3000_4o16jdca'}],
        model: 'TS0003_switch_module_2',
        vendor: 'TuYa',
        description: '3 gang switch module',
        extend: tuya.extend.switch({endpoints: ['l1', 'l2', 'l3']}),
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2, 'l3': 3};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(3), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0003', ['_TZ3000_vsasbzkf', '_TZ3000_odzoiovu']),
        model: 'TS0003_switch_module_1',
        vendor: 'TuYa',
        description: '3 gang switch module',
        whiteLabel: [{vendor: 'OXT', model: 'SWTZ23'}],
        extend: tuya.extend.switch({switchType: true, backlightModeOffOn: true, endpoints: ['l1', 'l2', 'l3']}),
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2, 'l3': 3};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(3), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0004', ['_TZ3000_ltt60asa', '_TZ3000_5ajpkyq6']),
        model: 'TS0004_switch_module',
        vendor: 'TuYa',
        description: '4 gang switch module',
        whiteLabel: [{vendor: 'OXT', model: 'SWTZ27'}],
        extend: tuya.extend.switch({switchType: true, endpoints: ['l1', 'l2', 'l3', 'l4']}),
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2, 'l3': 3, 'l4': 4};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(3), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(4), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        zigbeeModel: [
            'owvfni3\u0000', 'owvfni3', 'u1rkty3', 'aabybja', // Curtain motors
            'mcdj3aq', 'mcdj3aq\u0000', // Tubular motors
        ],
        fingerprint: [
            // Curtain motors:
            {modelID: 'TS0601', manufacturerName: '_TZE200_5zbp6j0u'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_nkoabg8w'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_xuzcvlku'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_4vobcgd3'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_nogaemzt'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_r0jdjrvi'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_pk0sfzvr'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_fdtjuw7u'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_zpzndjez'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_wmcdj3aq'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_cowvfni3'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_rddyvrci'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_nueqqe6k'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_bqcqqjpb'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_xaabybja'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_rmymn92d'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_3i3exuay'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_tvrvdj6o'},
            {modelID: 'zo2pocs\u0000', manufacturerName: '_TYST11_fzo2pocs'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_cf1sl3tj'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_b2u1drdv'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_ol5jlkkr'},
            // Roller blinds:
            {modelID: 'TS0601', manufacturerName: '_TZE200_fctwhugx'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_hsgrhjpf'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_pw7mji0l'},
            // Window pushers:
            {modelID: 'TS0601', manufacturerName: '_TZE200_g5wdnuow'},
            // Tubular motors:
            {modelID: 'TS0601', manufacturerName: '_TZE200_5sbebbzs'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_udank5zs'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_zuz7f94z'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_nv6nxo0c'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_3ylew7b4'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_llm0epxg'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_n1aauwb4'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_xu4a5rhj'},
            {modelID: 'TS0601', manufacturerName: '_TZE204_r0jdjrvi'},
        ],
        model: 'TS0601_cover_1',
        vendor: 'TuYa',
        description: 'Curtain motor/roller blind motor/window pusher/tubular motor',
        whiteLabel: [
            {vendor: 'Yushun', model: 'YS-MT750'},
            {vendor: 'Zemismart', model: 'ZM79E-DT'},
            {vendor: 'Binthen', model: 'BCM100D'},
            {vendor: 'Binthen', model: 'CV01A'},
            {vendor: 'Zemismart', model: 'M515EGB'},
            {vendor: 'OZ Smart Things', model: 'ZM85EL-1Z'},
            {vendor: 'TuYa', model: 'M515EGZT'},
            {vendor: 'TuYa', model: 'DT82LEMA-1.2N'},
            {vendor: 'TuYa', model: 'ZD82TN', description: 'Curtain motor'},
            {vendor: 'Larkkey', model: 'ZSTY-SM-1SRZG-EU'},
            {vendor: 'Zemismart', model: 'ZM85EL-2Z', description: 'Roman Rod I type curtains track'},
            {vendor: 'Zemismart', model: 'AM43', description: 'Roller blind motor'},
            {vendor: 'Zemismart', model: 'M2805EGBZTN', description: 'Tubular motor'},
            {vendor: 'Zemismart', model: 'BCM500DS-TYZ', description: 'Curtain motor'},
            {vendor: 'A-OK', model: 'AM25', description: 'Tubular motor'},
            {vendor: 'Alutech', model: 'AM/R-Sm', description: 'Tubular motor'},
        ],
        fromZigbee: [fz.tuya_cover, fz.ignore_basic_report],
        toZigbee: [tz.tuya_cover_control, tz.tuya_cover_options],
        exposes: [
            e.cover_position().setAccess('position', ea.STATE_SET),
            exposes.composite('options', 'options', ea.STATE_SET)
                .withFeature(exposes.numeric('motor_speed', ea.STATE_SET)
                    .withValueMin(0).withValueMax(255).withDescription('Motor speed'))
                .withFeature(exposes.binary('reverse_direction', ea.STATE_SET, true, false)
                    .withDescription('Reverse the motor direction'))],
    },
    {
        fingerprint: [
            // Curtain motors:
            {modelID: 'TS0601', manufacturerName: '_TZE200_eegnwoyw'},
        ],
        model: 'TS0601_cover_2',
        vendor: 'TuYa',
        description: 'Curtain motor fixed speed',
        whiteLabel: [
            {vendor: 'Zemismart', model: 'BCM100DB'},
        ],
        fromZigbee: [fz.tuya_cover, fz.ignore_basic_report],
        toZigbee: [tz.tuya_cover_control],
        exposes: [e.cover_position().setAccess('position', ea.STATE_SET)],
    },
    {
        zigbeeModel: ['kud7u2l'],
        fingerprint: [
            {modelID: 'TS0601', manufacturerName: '_TZE200_ckud7u2l'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_ywdxldoj'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_do5qy8zo'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_cwnjrr72'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_pvvbommb'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_9sfg7gm0'}, // HomeCloud
            {modelID: 'TS0601', manufacturerName: '_TZE200_2atgpdho'}, // HY367
            {modelID: 'TS0601', manufacturerName: '_TZE200_cpmgn2cf'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_8thwkzxl'}, // Tervix eva2
            {modelID: 'TS0601', manufacturerName: '_TZE200_4eeyebrt'}, // Immax 07732B
            {modelID: 'TS0601', manufacturerName: '_TZE200_8whxpsiw'}, // EVOLVEO
            {modelID: 'TS0601', manufacturerName: '_TZE200_xby0s3ta'}, // Sandy Beach HY367
            {modelID: 'TS0601', manufacturerName: '_TZE200_7fqkphoq'}, // AFINTEK
        ],
        model: 'TS0601_thermostat',
        vendor: 'TuYa',
        description: 'Radiator valve with thermostat',
        whiteLabel: [
            {vendor: 'Moes', model: 'HY368'},
            {vendor: 'Moes', model: 'HY369RT'},
            {vendor: 'SHOJZJ', model: '378RT'},
            {vendor: 'Silvercrest', model: 'TVR01'},
            {vendor: 'Immax', model: '07732B'},
            {vendor: 'Evolveo', model: 'Heat M30'},
        ],
        meta: {tuyaThermostatPreset: tuya.thermostatPresets, tuyaThermostatSystemMode: tuya.thermostatSystemModes3},
        ota: ota.zigbeeOTA,
        onEvent: tuya.onEventSetLocalTime,
        fromZigbee: [fz.tuya_thermostat, fz.ignore_basic_report, fz.ignore_tuya_set_time],
        toZigbee: [tz.tuya_thermostat_child_lock, tz.tuya_thermostat_window_detection, tz.tuya_thermostat_valve_detection,
            tz.tuya_thermostat_current_heating_setpoint, tz.tuya_thermostat_auto_lock,
            tz.tuya_thermostat_calibration, tz.tuya_thermostat_min_temp, tz.tuya_thermostat_max_temp,
            tz.tuya_thermostat_boost_time, tz.tuya_thermostat_comfort_temp, tz.tuya_thermostat_eco_temp,
            tz.tuya_thermostat_force_to_mode, tz.tuya_thermostat_force, tz.tuya_thermostat_preset, tz.tuya_thermostat_away_mode,
            tz.tuya_thermostat_window_detect, tz.tuya_thermostat_schedule, tz.tuya_thermostat_week, tz.tuya_thermostat_away_preset,
            tz.tuya_thermostat_schedule_programming_mode],
        exposes: [
            e.child_lock(), e.window_detection(),
            exposes.binary('window_open', ea.STATE).withDescription('Window open?'),
            e.battery_low(), e.valve_detection(), e.position(),
            exposes.climate().withSetpoint('current_heating_setpoint', 5, 35, 0.5, ea.STATE_SET)
                .withLocalTemperature(ea.STATE).withSystemMode(['heat', 'auto', 'off'], ea.STATE_SET,
                    'Mode of this device, in the `heat` mode the TS0601 will remain continuously heating, i.e. it does not regulate ' +
                    'to the desired temperature. If you want TRV to properly regulate the temperature you need to use mode `auto` ' +
                    'instead setting the desired temperature.')
                .withLocalTemperatureCalibration(-9, 9, 0.5, ea.STATE_SET)
                .withPreset(['schedule', 'manual', 'boost', 'complex', 'comfort', 'eco', 'away'])
                .withRunningState(['idle', 'heat'], ea.STATE),
            e.auto_lock(), e.away_mode(), e.away_preset_days(), e.boost_time(), e.comfort_temperature(), e.eco_temperature(), e.force(),
            e.max_temperature().withValueMin(16).withValueMax(70), e.min_temperature(), e.away_preset_temperature(),
            exposes.composite('programming_mode', 'programming_mode', ea.STATE).withDescription('Schedule MODE ⏱ - In this mode, ' +
                    'the device executes a preset week programming temperature time and temperature.')
                .withFeature(e.week())
                .withFeature(exposes.text('workdays_schedule', ea.STATE_SET))
                .withFeature(exposes.text('holidays_schedule', ea.STATE_SET))],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_68nvbio9']),
        model: 'TS0601_cover_3',
        vendor: 'TuYa',
        description: 'Cover motor',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        onEvent: tuya.onEventSetTime,
        options: [exposes.options.invert_cover()],
        configure: tuya.configureMagicPacket,
        exposes: [
            e.battery(), e.cover_position(),
            exposes.enum('reverse_direction', ea.STATE_SET, ['forward', 'back']).withDescription('Reverse the motor direction'),
            exposes.enum('border', ea.STATE_SET, ['up', 'down', 'up_delete', 'down_delete', 'remove_top_bottom']),
            exposes.enum('click_control', ea.STATE_SET, ['up', 'down']).withDescription('Single motor steps'),
            exposes.binary('motor_fault', ea.STATE, true, false),
        ],
        whiteLabel: [
            {vendor: 'Zemismart', model: 'ZM16EL-03/33'}, // _TZE200_68nvbio
        ],
        meta: {
            // All datapoints go in here
            tuyaDatapoints: [
                [1, 'state', tuya.valueConverterBasic.lookup({'OPEN': tuya.enum(0), 'STOP': tuya.enum(1), 'CLOSE': tuya.enum(2)})],
                [2, 'position', tuya.valueConverter.coverPosition],
                [3, 'position', tuya.valueConverter.raw],
                [5, 'reverse_direction', tuya.valueConverterBasic.lookup({'forward': tuya.enum(0), 'back': tuya.enum(1)})],
                [12, 'motor_fault', tuya.valueConverter.trueFalse1],
                [13, 'battery', tuya.valueConverter.raw],
                [16, 'border', tuya.valueConverterBasic.lookup({
                    'up': tuya.enum(0), 'down': tuya.enum(1), 'up_delete': tuya.enum(2), 'down_delete': tuya.enum(3),
                    'remove_top_bottom': tuya.enum(4)})],
                [20, 'click_control', tuya.valueConverterBasic.lookup({'up': tuya.enum(0), 'down': tuya.enum(1)})],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_zah67ekd']),
        model: 'TS0601_cover_4',
        vendor: 'TuYa',
        description: 'Cover',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        exposes: [
            e.cover_position().setAccess('position', ea.STATE_SET),
            exposes.enum('motor_direction', ea.STATE_SET, ['normal', 'reversed']).withDescription('Set the motor direction'),
            exposes.numeric('motor_speed', ea.STATE_SET).withValueMin(0).withValueMax(255).withDescription('Motor speed').withUnit('rpm'),
            exposes.enum('opening_mode', ea.STATE_SET, ['tilt', 'lift']).withDescription('Opening mode'),
            exposes.enum('set_upper_limit', ea.STATE_SET, ['SET']).withDescription('Set the upper limit, to reset limits use factory_reset'),
            exposes.enum('set_bottom_limit', ea.STATE_SET, ['SET']).withDescription('Set the bottom limit, to reset limits use factory_reset'),
            exposes.binary('factory_reset', ea.STATE_SET, true, false).withDescription('Factory reset the device'),
        ],
        whiteLabel: [
            tuya.whitelabel('Moes', 'AM43-0.45/40-ES-EB', 'Roller blind/shades drive motor', ['_TZE200_zah67ekd']),
        ],
        meta: {
            tuyaDatapoints: [
                [1, 'state', tuya.valueConverterBasic.lookup({'OPEN': tuya.enum(0), 'STOP': tuya.enum(1), 'CLOSE': tuya.enum(2)})],
                [2, 'position', tuya.valueConverter.coverPosition],
                [3, 'position', tuya.valueConverter.raw],
                [5, 'motor_direction', tuya.valueConverterBasic.lookup({'normal': tuya.enum(0), 'reversed': tuya.enum(1)})],
                [7, null, null], // work_state, not usefull, ignore
                [101, 'opening_mode', tuya.valueConverterBasic.lookup({'tilt': tuya.enum(0), 'lift': tuya.enum(1)})],
                [102, 'factory_reset', tuya.valueConverter.raw],
                [103, 'set_upper_limit', tuya.valueConverter.setLimit],
                [104, 'set_bottom_limit', tuya.valueConverter.setLimit],
                [105, 'motor_speed', tuya.valueConverter.raw],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', [
            '_TZE200_sur6q7ko', /* model: '3012732', vendor: 'LSC Smart Connect' */
            '_TZE200_hue3yfsn', /* model: 'TV02-Zigbee', vendor: 'TuYa' */
            '_TZE200_e9ba97vf', /* model: 'TV01-ZB', vendor: 'Moes' */
            '_TZE200_husqqvux', /* model: 'TSL-TRV-TV01ZG', vendor: 'Tesla Smart' */
            '_TZE200_lnbfnyxd', /* model: 'TSL-TRV-TV01ZG', vendor: 'Tesla Smart' */
            '_TZE200_lllliz3p', /* model: 'TV02-Zigbee', vendor: 'TuYa' */
            '_TZE200_mudxchsu', /* model: 'TV05-ZG curve', vendor: 'TuYa' */
            '_TZE200_7yoranx2', /* model: 'TV01-ZB', vendor: 'Moes' */
            '_TZE200_kds0pmmv', /* model: 'TV01-ZB', vendor: 'Moes' */
        ]),
        model: 'TV02-Zigbee',
        vendor: 'TuYa',
        description: 'Thermostat radiator valve',
        whiteLabel: [
            {vendor: 'Moes', model: 'TV01-ZB'},
            {vendor: 'AVATTO', model: 'TRV06'},
            {vendor: 'Tesla Smart', model: 'TSL-TRV-TV01ZG'},
            {vendor: 'Unknown/id3.pl', model: 'GTZ08'},
            tuya.whitelabel('Moes', 'ZTRV-ZX-TV01-MS', 'Thermostat radiator valve', ['_TZE200_7yoranx2']),
        ],
        ota: ota.zigbeeOTA,
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        onEvent: tuya.onEventSetLocalTime,
        configure: tuya.configureMagicPacket,
        exposes: [
            e.battery_low(), e.child_lock(), e.open_window(), e.open_window_temperature().withValueMin(5).withValueMax(30),
            e.comfort_temperature().withValueMin(5).withValueMax(30), e.eco_temperature().withValueMin(5).withValueMax(30),
            exposes.climate().withPreset(['auto', 'manual', 'holiday']).withLocalTemperatureCalibration(-5, 5, 0.1, ea.STATE_SET)
                .withLocalTemperature(ea.STATE).withSetpoint('current_heating_setpoint', 5, 30, 0.5, ea.STATE_SET)
                .withSystemMode(['off', 'heat'], ea.STATE_SET, 'Only for Homeassistant'),
            exposes.binary('heating_stop', ea.STATE_SET, 'ON', 'OFF').withDescription('Battery life can be prolonged'+
                    ' by switching the heating off. To achieve this, the valve is closed fully. To activate the '+
                    'heating stop, the device display "HS", press the pair button to cancel.'),
            tuya.exposes.frostProtection('When Anti-Freezing function is activated, the temperature in the house is kept '+
                    'at 8 °C, the device display "AF".press the pair button to cancel.'),
            exposes.numeric('boost_timeset_countdown', ea.STATE_SET).withUnit('second').withDescription('Setting '+
                    'minimum 0 - maximum 465 seconds boost time. The boost (♨) function is activated. The remaining '+
                    'time for the function will be counted down in seconds ( 465 to 0 ).').withValueMin(0).withValueMax(465),
            e.holiday_temperature().withValueMin(5).withValueMax(30),
            exposes.text('holiday_start_stop', ea.STATE_SET).withDescription('The holiday mode will automatically start ' +
                'at the set time starting point and run the holiday temperature. Can be defined in the following format: ' +
                '`startYear/startMonth/startDay startHours:startMinutes | endYear/endMonth/endDay endHours:endMinutes`. ' +
                'For example: `2022/10/01 16:30 | 2022/10/21 18:10`. After the end of holiday mode, it switches to "auto" ' +
                'mode and uses schedule.'),
            exposes.enum('working_day', ea.STATE_SET, ['mon_sun', 'mon_fri+sat+sun', 'separate']).withDescription('`mon_sun` ' +
                '- schedule for Monday used for each day (define it only for Monday). `mon_fri+sat+sun` - schedule for ' +
                'workdays used from Monday (define it only for Monday), Saturday and Sunday are defined separately. `separate` ' +
                '- schedule for each day is defined separately.'),
            exposes.composite('schedule', 'schedule', ea.SET).withFeature(exposes.enum('week_day', ea.SET, ['monday', 'tuesday',
                'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])).withFeature(exposes.text('schedule', ea.SET))
                .withDescription('Schedule will work with "auto" preset. In this mode, the device executes ' +
                'a preset week programming temperature time and temperature. Before using these properties, check `working_day` ' +
                'property. Each day can contain up to 10 segments. At least 1 segment should be defined. Different count of segments ' +
                'can be defined for each day, e.g., 3 segments for Monday, 5 segments for Thursday, etc. It should be defined in the ' +
                'following format: `hours:minutes/temperature`. Minutes can be only tens, i.e., 00, 10, 20, 30, 40, 50. Segments should ' +
                'be divided by space symbol. Each day should end with the last segment of 24:00. Examples: `04:00/20 08:30/22 10:10/18 ' +
                '18:40/24 22:50/19.5`; `06:00/21.5 17:20/26 24:00/18`. The temperature will be set from the beginning/start of one ' +
                'period and until the next period, e.g., `04:00/20 24:00/22` means that from 00:00 to 04:00 temperature will be 20 ' +
                'degrees and from 04:00 to 00:00 temperature will be 22 degrees.'),
            ...tuya.exposes.scheduleAllDays(ea.STATE, 'HH:MM/C'),
            exposes.binary('online', ea.STATE_SET, 'ON', 'OFF').withDescription('The current data request from the device.'),
            tuya.exposes.errorStatus(),
        ],
        meta: {
            tuyaDatapoints: [
                [2, 'preset', tuya.valueConverterBasic.lookup({'auto': tuya.enum(0), 'manual': tuya.enum(1), 'holiday': tuya.enum(3)})],
                [8, 'open_window', tuya.valueConverter.onOff],
                [10, null, tuya.valueConverter.TV02FrostProtection],
                [10, 'frost_protection', tuya.valueConverter.TV02FrostProtection],
                [16, 'current_heating_setpoint', tuya.valueConverter.divideBy10],
                [24, 'local_temperature', tuya.valueConverter.divideBy10],
                [27, 'local_temperature_calibration', tuya.valueConverter.localTempCalibration1],
                [31, 'working_day', tuya.valueConverterBasic.lookup({'mon_sun': tuya.enum(0), 'mon_fri+sat+sun': tuya.enum(1),
                    'separate': tuya.enum(2)})],
                [32, 'holiday_temperature', tuya.valueConverter.divideBy10],
                [35, 'battery_low', tuya.valueConverter.trueFalse0],
                [40, 'child_lock', tuya.valueConverter.lockUnlock],
                [45, 'error_status', tuya.valueConverter.raw],
                [46, 'holiday_start_stop', tuya.valueConverter.thermostatHolidayStartStop],
                [101, 'boost_timeset_countdown', tuya.valueConverter.raw],
                [102, 'open_window_temperature', tuya.valueConverter.divideBy10],
                [104, 'comfort_temperature', tuya.valueConverter.divideBy10],
                [105, 'eco_temperature', tuya.valueConverter.divideBy10],
                [106, 'schedule', tuya.valueConverter.thermostatScheduleDaySingleDP],
                [107, null, tuya.valueConverter.TV02SystemMode],
                [107, 'system_mode', tuya.valueConverter.TV02SystemMode],
                [107, 'heating_stop', tuya.valueConverter.TV02SystemMode],
                [115, 'online', tuya.valueConverter.onOffNotStrict],
                [108, 'schedule_monday', tuya.valueConverter.thermostatScheduleDaySingleDP],
                [112, 'schedule_tuesday', tuya.valueConverter.thermostatScheduleDaySingleDP],
                [109, 'schedule_wednesday', tuya.valueConverter.thermostatScheduleDaySingleDP],
                [113, 'schedule_thursday', tuya.valueConverter.thermostatScheduleDaySingleDP],
                [110, 'schedule_friday', tuya.valueConverter.thermostatScheduleDaySingleDP],
                [114, 'schedule_saturday', tuya.valueConverter.thermostatScheduleDaySingleDP],
                [111, 'schedule_sunday', tuya.valueConverter.thermostatScheduleDaySingleDP],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', [
            '_TZE200_0hg58wyk', /* model: 'S366', vendor: 'Cloud Even' */
        ]),
        model: 'TS0601_thermostat_2',
        vendor: 'TuYa',
        description: 'Thermostat radiator valve',
        whiteLabel: [
            {vendor: 'S366', model: 'Cloud Even'},
        ],
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        onEvent: tuya.onEventSetLocalTime,
        configure: tuya.configureMagicPacket,
        meta: {
            tuyaDatapoints: [
                [1, 'system_mode', tuya.valueConverterBasic.lookup({'heat': true, 'off': false})],
                [2, 'preset', tuya.valueConverterBasic.lookup({'manual': tuya.enum(0), 'holiday': tuya.enum(1), 'program': tuya.enum(2)})],
                [3, null, null], // TODO: Unknown DP
                [8, 'open_window', tuya.valueConverter.onOff],
                [10, 'frost_protection', tuya.valueConverter.onOff],
                [16, 'current_heating_setpoint', tuya.valueConverter.divideBy10],
                [24, 'local_temperature', tuya.valueConverter.divideBy10],
                [27, 'local_temperature_calibration', tuya.valueConverter.localTempCalibration1],
                [35, 'battery_low', tuya.valueConverter.trueFalse0],
                [40, 'child_lock', tuya.valueConverter.lockUnlock],
                [45, 'error_status', tuya.valueConverter.raw],
                [101, 'schedule_monday', tuya.valueConverter.thermostatScheduleDayMultiDP],
                [102, 'schedule_tuesday', tuya.valueConverter.thermostatScheduleDayMultiDP],
                [103, 'schedule_wednesday', tuya.valueConverter.thermostatScheduleDayMultiDP],
                [104, 'schedule_thursday', tuya.valueConverter.thermostatScheduleDayMultiDP],
                [105, 'schedule_friday', tuya.valueConverter.thermostatScheduleDayMultiDP],
                [106, 'schedule_saturday', tuya.valueConverter.thermostatScheduleDayMultiDP],
                [107, 'schedule_sunday', tuya.valueConverter.thermostatScheduleDayMultiDP],
            ],
        },
        exposes: [
            e.battery_low(), e.child_lock(), e.open_window(), tuya.exposes.frostProtection(), tuya.exposes.errorStatus(),
            exposes.climate()
                .withSystemMode(['off', 'heat'], ea.STATE_SET)
                .withPreset(['manual', 'holiday', 'program'])
                .withLocalTemperatureCalibration(-5, 5, 0.1, ea.STATE_SET)
                .withLocalTemperature(ea.STATE)
                .withSetpoint('current_heating_setpoint', 5, 30, 0.5, ea.STATE_SET),
            ...tuya.exposes.scheduleAllDays(ea.STATE_SET, 'HH:MM/C HH:MM/C HH:MM/C HH:MM/C'),
        ],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', [
            '_TZE200_bvu2wnxz', /* model: 'ME167', vendor: 'Avatto' */
            '_TZE200_6rdj8dzm', /* model: 'ME167', vendor: 'Avatto' */
            '_TZE200_gd4rvykv', // Sanico
        ]),
        model: 'TS0601_thermostat_3',
        vendor: 'TuYa',
        description: 'Thermostatic radiator valve',
        fromZigbee: [tuya.fzDataPoints],
        toZigbee: [tuya.tzDataPoints],
        whiteLabel: [{vendor: 'Avatto', model: 'ME167'}],
        onEvent: tuya.onEventSetTime,
        configure: tuya.configureMagicPacket,
        exposes: [
            e.child_lock(), e.battery_low(),
            exposes.climate()
                .withSetpoint('current_heating_setpoint', 5, 35, 1, ea.STATE_SET)
                .withLocalTemperature(ea.STATE)
                .withSystemMode(['auto', 'heat', 'off'], ea.STATE_SET)
                .withRunningState(['idle', 'heat'], ea.STATE)
                .withLocalTemperatureCalibration(-3, 3, 1, ea.STATE_SET),
            exposes.binary('scale_protection', ea.STATE_SET, 'ON', 'OFF').withDescription('If the heat sink is not fully opened within ' +
                'two weeks or is not used for a long time, the valve will be blocked due to silting up and the heat sink will not be ' +
                'able to be used. To ensure normal use of the heat sink, the controller will automatically open the valve fully every ' +
                'two weeks. It will run for 30 seconds per time with the screen displaying "Ad", then return to its normal working state ' +
                'again.'),
            exposes.binary('frost_protection', ea.STATE_SET, 'ON', 'OFF').withDescription('When the room temperature is lower than ' +
                '5 °C, the valve opens; when the temperature rises to 8 °C, the valve closes.'),
            exposes.numeric('error', ea.STATE).withDescription('If NTC is damaged, "Er" will be on the TRV display.'),
        ],
        meta: {
            tuyaDatapoints: [
                [2, 'system_mode', tuya.valueConverterBasic.lookup({'auto': tuya.enum(0), 'heat': tuya.enum(1), 'off': tuya.enum(2)})],
                [3, 'running_state', tuya.valueConverterBasic.lookup({'heat': tuya.enum(0), 'idle': tuya.enum(1)})],
                [4, 'current_heating_setpoint', tuya.valueConverter.divideBy10],
                [5, 'local_temperature', tuya.valueConverter.divideBy10],
                [7, 'child_lock', tuya.valueConverter.lockUnlock],
                [35, null, tuya.valueConverter.errorOrBatteryLow],
                [36, 'frost_protection', tuya.valueConverter.onOff],
                [39, 'scale_protection', tuya.valueConverter.onOff],
                [47, 'local_temperature_calibration', tuya.valueConverter.localTempCalibration2],
            ],
        },
    },
    {
        fingerprint: [
            {modelID: 'v90ladg\u0000', manufacturerName: '_TYST11_wv90ladg'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_wv90ladg'},
        ],
        model: 'HT-08',
        vendor: 'ETOP',
        description: 'Wall-mount thermostat',
        fromZigbee: [fz.legacy.tuya_thermostat_weekly_schedule, fz.etop_thermostat, fz.ignore_basic_report, fz.ignore_tuya_set_time],
        toZigbee: [tz.etop_thermostat_system_mode, tz.etop_thermostat_away_mode, tz.tuya_thermostat_child_lock,
            tz.tuya_thermostat_current_heating_setpoint, tz.tuya_thermostat_weekly_schedule],
        onEvent: tuya.onEventSetTime,
        meta: {
            thermostat: {
                weeklyScheduleMaxTransitions: 4,
                weeklyScheduleSupportedModes: [1], // bits: 0-heat present, 1-cool present (dec: 1-heat,2-cool,3-heat+cool)
                weeklyScheduleFirstDayDpId: tuya.dataPoints.schedule,
            },
        },
        exposes: [e.child_lock(), e.away_mode(), exposes.climate().withSetpoint('current_heating_setpoint', 5, 35, 0.5, ea.STATE_SET)
            .withLocalTemperature(ea.STATE)
            .withSystemMode(['off', 'heat', 'auto'], ea.STATE_SET).withRunningState(['idle', 'heat'], ea.STATE)],
    },
    {
        fingerprint: [{modelID: 'dpplnsn\u0000', manufacturerName: '_TYST11_2dpplnsn'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_2dpplnsn'}],
        model: 'HT-10',
        vendor: 'ETOP',
        description: 'Radiator valve',
        fromZigbee: [fz.legacy.tuya_thermostat_weekly_schedule, fz.etop_thermostat, fz.ignore_basic_report, fz.ignore_tuya_set_time],
        toZigbee: [tz.etop_thermostat_system_mode, tz.etop_thermostat_away_mode, tz.tuya_thermostat_child_lock,
            tz.tuya_thermostat_current_heating_setpoint, tz.tuya_thermostat_weekly_schedule],
        onEvent: tuya.onEventSetTime,
        meta: {
            timeout: 20000, // TRV wakes up every 10sec
            thermostat: {
                weeklyScheduleMaxTransitions: 4,
                weeklyScheduleSupportedModes: [1], // bits: 0-heat present, 1-cool present (dec: 1-heat,2-cool,3-heat+cool)
                weeklyScheduleFirstDayDpId: tuya.dataPoints.schedule,
            },
        },
        exposes: [
            e.battery_low(), e.child_lock(), e.away_mode(), exposes.climate()
                .withSetpoint('current_heating_setpoint', 5, 35, 0.5, ea.STATE_SET)
                .withLocalTemperature(ea.STATE)
                .withSystemMode(['off', 'heat', 'auto'], ea.STATE_SET).withRunningState(['idle', 'heat'], ea.STATE),
        ],
    },
    {
        fingerprint: [
            {modelID: 'TS0601', manufacturerName: '_TZE200_a4bpgplm'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_dv8abrrz'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_z1tyspqw'},
        ],
        model: 'TS0601_thermostat_1',
        vendor: 'TuYa',
        description: 'Thermostatic radiator valve',
        whiteLabel: [
            {vendor: 'Unknown/id3.pl', model: 'GTZ06'},
        ],
        onEvent: tuya.onEventSetLocalTime,
        fromZigbee: [tuya.fzDataPoints],
        toZigbee: [tuya.tzDataPoints],
        configure: tuya.configureMagicPacket,
        exposes: [
            e.battery(), e.child_lock(), e.max_temperature(), e.min_temperature(),
            e.position(), e.window_detection(),
            exposes.binary('window', ea.STATE, 'CLOSED', 'OPEN').withDescription('Window status closed or open '),
            exposes.binary('alarm_switch', ea.STATE, 'ON', 'OFF').withDescription('Thermostat in error state'),
            exposes.climate()
                .withLocalTemperature(ea.STATE).withSetpoint('current_heating_setpoint', 5, 35, 0.5, ea.STATE_SET)
                .withLocalTemperatureCalibration(-30, 30, 0.1, ea.STATE_SET)
                .withPreset(['auto', 'manual', 'off', 'on'],
                    'MANUAL MODE ☝ - In this mode, the device executes manual temperature setting. ' +
                'When the set temperature is lower than the "minimum temperature", the valve is closed (forced closed). ' +
                'AUTO MODE ⏱ - In this mode, the device executes a preset week programming temperature time and temperature. ' +
                'ON - In this mode, the thermostat stays open ' +
                'OFF - In this mode, the thermostat stays closed')
                .withSystemMode(['auto', 'heat', 'off'], ea.STATE)
                .withRunningState(['idle', 'heat'], ea.STATE),
            ...tuya.exposes.scheduleAllDays(ea.STATE_SET, 'HH:MM/C HH:MM/C HH:MM/C HH:MM/C'),
            exposes.binary('boost_heating', ea.STATE_SET, 'ON', 'OFF')
                .withDescription('Boost Heating: press and hold "+" for 3 seconds, ' +
                'the device will enter the boost heating mode, and the ▷╵◁ will flash. The countdown will be displayed in the APP'),
            exposes.numeric('boost_time', ea.STATE_SET).withUnit('min').withDescription('Countdown in minutes')
                .withValueMin(0).withValueMax(1000),
        ],
        meta: {
            tuyaDatapoints: [
                [1, null,
                    {
                        from: (v) => {
                            const presetLookup = {0: 'auto', 1: 'manual', 2: 'off', 3: 'on'};
                            const systemModeLookup = {0: 'auto', 1: 'auto', 2: 'off', 3: 'heat'};
                            return {preset: presetLookup[v], system_mode: systemModeLookup[v]};
                        },
                    },
                ],
                [1, 'system_mode', tuya.valueConverterBasic.lookup({'auto': tuya.enum(1), 'off': tuya.enum(2), 'heat': tuya.enum(3)})],
                [1, 'preset', tuya.valueConverterBasic.lookup(
                    {'auto': tuya.enum(0), 'manual': tuya.enum(1), 'off': tuya.enum(2), 'on': tuya.enum(3)})],
                [2, 'current_heating_setpoint', tuya.valueConverter.divideBy10],
                [3, 'local_temperature', tuya.valueConverter.divideBy10],
                [4, 'boost_heating', tuya.valueConverter.onOff],
                [5, 'boost_time', tuya.valueConverter.countdown],
                [6, 'running_state', tuya.valueConverterBasic.lookup({'heat': 1, 'idle': 0})],
                [7, 'window', tuya.valueConverterBasic.lookup({'OPEN': 1, 'CLOSE': 0})],
                [8, 'window_detection', tuya.valueConverter.onOff],
                [12, 'child_lock', tuya.valueConverter.lockUnlock],
                [13, 'battery', tuya.valueConverter.raw],
                [14, 'alarm_switch', tuya.valueConverter.onOff],
                [15, 'min_temperature', tuya.valueConverter.divideBy10],
                [16, 'max_temperature', tuya.valueConverter.divideBy10],
                [17, 'schedule_monday', tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(1)],
                [18, 'schedule_tuesday', tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(2)],
                [19, 'schedule_wednesday', tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(3)],
                [20, 'schedule_thursday', tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(4)],
                [21, 'schedule_friday', tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(5)],
                [22, 'schedule_saturday', tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(6)],
                [23, 'schedule_sunday', tuya.valueConverter.thermostatScheduleDayMultiDPWithDayNumber(7)],
                [101, 'local_temperature_calibration', tuya.valueConverter.localTempCalibration1],
                [102, 'position', tuya.valueConverter.divideBy10],
            ],
        },
    },
    {
        zigbeeModel: ['TS0121'],
        model: 'TS0121_plug',
        description: '10A UK or 16A EU smart plug',
        whiteLabel: [
            {vendor: 'BlitzWolf', model: 'BW-SHP13'},
            {vendor: 'Connecte', model: '4500990'},
            {vendor: 'Connecte', model: '4500991'},
            {vendor: 'Connecte', model: '4500992'},
            {vendor: 'Connecte', model: '4500993'},
        ],
        vendor: 'TuYa',
        fromZigbee: [fz.on_off, fz.electrical_measurement, fz.metering, fz.ignore_basic_report, tuya.fz.power_outage_memory,
            tuya.fz.indicator_mode],
        toZigbee: [tz.on_off, tuya.tz.power_on_behavior_1, tuya.tz.backlight_indicator_mode_1],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'haElectricalMeasurement', 'seMetering']);
            endpoint.saveClusterAttributeKeyValue('seMetering', {divisor: 100, multiplier: 1});
            endpoint.saveClusterAttributeKeyValue('haElectricalMeasurement', {
                acVoltageMultiplier: 1, acVoltageDivisor: 1, acCurrentMultiplier: 1, acCurrentDivisor: 1000, acPowerMultiplier: 1,
                acPowerDivisor: 1,
            });
            try {
                await reporting.currentSummDelivered(endpoint);
                await reporting.rmsVoltage(endpoint, {change: 5});
                await reporting.rmsCurrent(endpoint, {change: 50});
                await reporting.activePower(endpoint, {change: 10});
            } catch (error) {/* fails for some https://github.com/Koenkk/zigbee2mqtt/issues/11179
                                and https://github.com/Koenkk/zigbee2mqtt/issues/16864 */}
            await endpoint.read('genOnOff', ['onOff', 'moesStartUpOnOff', 'tuyaBacklightMode']);
        },
        options: [exposes.options.measurement_poll_interval()],
        // This device doesn't support reporting correctly.
        // https://github.com/Koenkk/zigbee-herdsman-converters/pull/1270
        exposes: [e.switch(), e.power(), e.current(), e.voltage(),
            e.energy(), exposes.enum('power_outage_memory', ea.ALL, ['on', 'off', 'restore'])
                .withDescription('Recover state after power outage'),
            exposes.enum('indicator_mode', ea.ALL, ['off', 'off/on', 'on/off']).withDescription('LED indicator mode')],
        onEvent: tuya.onEventMeasurementPoll,
    },
    {
        fingerprint: [{modelID: 'TS0111', manufacturerName: '_TYZB01_ymcdbl3u'}],
        model: 'TS0111_valve',
        vendor: 'TuYa',
        whiteLabel: [{vendor: 'TuYa', model: 'SM-AW713Z'}],
        description: 'Smart water/gas valve',
        extend: tuya.extend.switch({indicatorMode: true}),
    },
    {
        // Note: below you will find the TS011F_plug_2 and TS011F_plug_3. These are identified via a fingerprint and
        // thus preferred above the TS011F_plug_1 if the fingerprint matches
        zigbeeModel: ['TS011F'],
        model: 'TS011F_plug_1',
        description: 'Smart plug (with power monitoring)',
        vendor: 'TuYa',
        whiteLabel: [{vendor: 'LELLKI', model: 'TS011F_plug'}, {vendor: 'NEO', model: 'NAS-WR01B'},
            {vendor: 'BlitzWolf', model: 'BW-SHP15'}, {vendor: 'Nous', model: 'A1Z'}, {vendor: 'BlitzWolf', model: 'BW-SHP13'},
            {vendor: 'MatSee Plus', model: 'PJ-ZSW01'}, {vendor: 'MODEMIX', model: 'MOD037'}, {vendor: 'MODEMIX', model: 'MOD048'},
            {vendor: 'Coswall', model: 'CS-AJ-DE2U-ZG-11'}, {vendor: 'Aubess', model: 'TS011F_plug_1'}, {vendor: 'Immax', model: '07752L'},
            tuya.whitelabel('NOUS', 'A1Z', 'Smart plug (with power monitoring)', ['_TZ3000_2putqrmw']),
        ],
        ota: ota.zigbeeOTA,
        extend: tuya.extend.switch({
            electricalMeasurements: true, electricalMeasurementsFzConverter: fzLocal.TS011F_electrical_measurement,
            powerOutageMemory: true, indicatorMode: true, childLock: true}),
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'haElectricalMeasurement', 'seMetering']);
            await reporting.rmsVoltage(endpoint, {change: 5});
            await reporting.rmsCurrent(endpoint, {change: 50});
            await reporting.activePower(endpoint, {change: 10});
            await reporting.currentSummDelivered(endpoint);
            endpoint.saveClusterAttributeKeyValue('haElectricalMeasurement', {acCurrentDivisor: 1000, acCurrentMultiplier: 1});
            endpoint.saveClusterAttributeKeyValue('seMetering', {divisor: 100, multiplier: 1});
            device.save();
        },
    },
    {
        fingerprint: tuya.fingerprint('TS011F',
            ['_TZ3000_hyfvrar3', '_TZ3000_v1pdxuqq', '_TZ3000_8a833yls', '_TZ3000_bfn1w0mm', '_TZ3000_nzkqcvvs', '_TZ3000_rtcrrvia']),
        model: 'TS011F_plug_2',
        description: 'Smart plug (without power monitoring)',
        vendor: 'TuYa',
        extend: tuya.extend.switch({powerOutageMemory: true, indicatorMode: true, childLock: true}),
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        fingerprint: [160, 100, 69, 68, 65, 64, 66].map((applicationVersion) => {
            return {modelID: 'TS011F', applicationVersion, priority: -1};
        }),
        model: 'TS011F_plug_3',
        description: 'Smart plug (with power monitoring by polling)',
        vendor: 'TuYa',
        whiteLabel: [{vendor: 'VIKEFON', model: 'TS011F'}, {vendor: 'BlitzWolf', model: 'BW-SHP15'},
            {vendor: 'Avatto', model: 'MIUCOT10Z'}, {vendor: 'Neo', model: 'NAS-WR01B'}, {vendor: 'Neo', model: 'PLUG-001SPB2'}],
        ota: ota.zigbeeOTA,
        extend: tuya.extend.switch({electricalMeasurements: true, powerOutageMemory: true, indicatorMode: true, childLock: true}),
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            endpoint.saveClusterAttributeKeyValue('haElectricalMeasurement', {acCurrentDivisor: 1000, acCurrentMultiplier: 1});
            endpoint.saveClusterAttributeKeyValue('seMetering', {divisor: 100, multiplier: 1});
            device.save();
        },
        options: [exposes.options.measurement_poll_interval()],
        onEvent: (type, data, device, options) =>
            tuya.onEventMeasurementPoll(type, data, device, options,
                device.applicationVersion !== 66, // polling for voltage, current and power
                [66, 100, 160].includes(device.applicationVersion), // polling for energy
            ),
    },
    {
        fingerprint: [{modelID: 'TS011F', manufacturerName: '_TZ3000_wbloefbf'}],
        model: 'TS011F_switch_5_gang',
        description: '2 gang 2 usb 1 wall ac outlet',
        whiteLabel: [{vendor: 'Milfra', model: 'M11Z'}],
        vendor: 'TuYa',
        extend: tuya.extend.switch({powerOutageMemory: true, childLock: true, endpoints: ['l1', 'l2', 'l3', 'l4', 'l5']}),
        endpoint: (device) => {
            return {l1: 1, l2: 2, l3: 3, l4: 4, l5: 5};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(3), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(4), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(5), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        fingerprint: tuya.fingerprint('TS011F', ['_TZ3000_dlug3kbc']),
        model: 'TS011F_3_gang',
        description: '3 gang wall ac outlet',
        vendor: 'TuYa',
        extend: tuya.extend.switch({powerOutageMemory: true, childLock: true, endpoints: ['l1', 'l2', 'l3']}),
        endpoint: (device) => {
            return {l1: 1, l2: 2, l3: 3, l4: 4, l5: 5};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            for (const ep of [1, 2, 3]) {
                await reporting.bind(device.getEndpoint(ep), coordinatorEndpoint, ['genOnOff']);
            }
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_ntcy3xu1']),
        model: 'TS0601_smoke_1',
        vendor: 'TuYa',
        description: 'Smoke sensor',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [e.smoke(), e.tamper(), e.battery_low()],
        meta: {
            tuyaDatapoints: [
                [1, 'smoke', tuya.valueConverter.trueFalse0],
                [4, 'tamper', tuya.valueConverter.raw],
                [14, 'battery_low', tuya.valueConverter.trueFalse0],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_m9skfctm']),
        model: 'TS0601_smoke_2',
        vendor: 'TuYa',
        description: 'Photoelectric smoke detector',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        onEvent: tuya.onEventSetTime,
        configure: tuya.configureMagicPacket,
        exposes: [
            e.smoke(), e.battery(), e.test(),
            exposes.numeric('smoke_concentration', ea.STATE).withUnit('ppm').withDescription('Parts per million of smoke detected'),
            exposes.binary('device_fault', ea.STATE, true, false).withDescription('Indicates a fault with the device'),
        ],
        meta: {
            tuyaDatapoints: [
                [1, 'smoke', tuya.valueConverter.trueFalse0],
                [2, 'smoke_concentration', tuya.valueConverter.divideBy10],
                [11, 'device_fault', tuya.valueConverter.raw],
                [15, 'battery', tuya.valueConverter.raw],
                [101, 'test', tuya.valueConverter.raw],
            ],
        },
        whiteLabel: [
            tuya.whitelabel('TuYa', 'PA-44Z', 'Smoke detector', ['_TZE200_m9skfctm']),
        ],
    },
    {
        fingerprint: [
            {modelID: 'TS0601', manufacturerName: '_TZE200_ux5v4dbd'}, // [KnockautX / Brelag AG, Switzerland](https://www.brelag.com)
        ],
        vendor: 'TuYa',
        model: 'TS0601_smoke_3',
        description: 'Photoelectric smoke detector',
        whiteLabel: [
            {vendor: 'KnockautX', model: 'SMOAL024'},
        ],
        configure: tuya.configureMagicPacket,
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        exposes: [e.smoke(), tuya.exposes.batteryState()],
        meta: {
            tuyaDatapoints: [
                /**
                 * According to the Vendor "KnockautX / Brelag AG" DP 16 "muffling"
                 * is supported as well. But it was not possible to verify this using
                 * SMOLA024 devices - therefore it is not included in the device definition.
                 *
                 * Data Transfer Type: Send and Report
                 * Data Type: Bool
                 * muffling: 16,
                 */
                [1, 'smoke', tuya.valueConverter.trueFalse0],
                [14, 'battery_state', tuya.valueConverter.batteryState],
            ],
        },
    },
    {
        zigbeeModel: ['5p1vj8r'],
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_t5p1vj8r', '_TZE200_uebojraa', '_TZE200_vzekyi4c', '_TZE200_yh7aoahi',
            '_TZE200_dnz6yvl2', '_TZE200_dq1mfjug']),
        model: 'TS0601_smoke_4',
        vendor: 'TuYa',
        description: 'Smoke sensor',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        exposes: [e.smoke(), e.battery(), tuya.exposes.batteryState()],
        meta: {
            tuyaDatapoints: [
                [1, 'smoke', tuya.valueConverter.trueFalse0],
                [14, 'battery_state', tuya.valueConverter.batteryState],
                [15, 'battery', tuya.valueConverter.raw],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_ytibqbra']),
        model: 'TS0601_smoke_5',
        vendor: 'TuYa',
        description: 'Smoke sensor',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [e.smoke(), e.tamper(), e.battery(), tuya.exposes.faultAlarm(),
            tuya.exposes.silence(), exposes.binary('alarm', ea.STATE_SET, 'ON', 'OFF').withDescription('Enable the alarm')],
        meta: {
            tuyaDatapoints: [
                [1, 'smoke', tuya.valueConverter.trueFalse0],
                [4, 'tamper', tuya.valueConverter.raw],
                [11, 'fault_alarm', tuya.valueConverter.trueFalse1],
                [15, 'battery', tuya.valueConverter.raw],
                [16, 'silence', tuya.valueConverter.raw],
                [17, 'alarm', tuya.valueConverter.onOff],
            ],
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_5d3vhjro'}],
        model: 'SA12IZL',
        vendor: 'TuYa',
        description: 'Smart smoke alarm',
        meta: {timeout: 30000, disableDefaultResponse: true},
        fromZigbee: [fzLocal.SA12IZL],
        toZigbee: [tzLocal.SA12IZL_silence_siren, tzLocal.SA12IZL_alarm],
        exposes: [e.battery(),
            exposes.binary('smoke', ea.STATE, true, false).withDescription('Smoke alarm status'),
            exposes.enum('battery_level', ea.STATE, ['low', 'middle', 'high']).withDescription('Battery level state'),
            exposes.binary('alarm', ea.STATE_SET, true, false).withDescription('Enable the alarm'),
            exposes.binary('silence_siren', ea.STATE_SET, true, false).withDescription('Silence the siren')],
        onEvent: tuya.onEventsetTime,
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE204_cjbofhxw']),
        model: 'TS0601_clamp_meter',
        vendor: 'TuYa',
        description: 'Clamp meter',
        fromZigbee: [tuya.fz.datapoints, tuya.fz.gateway_connection_status],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [e.current(), e.power(), e.voltage(), e.energy()],
        meta: {
            tuyaDatapoints: [
                [18, 'current', tuya.valueConverter.divideBy1000],
                [19, 'power', tuya.valueConverter.divideBy10],
                [20, 'voltage', tuya.valueConverter.divideBy10],
                [101, 'energy', tuya.valueConverter.divideBy1000],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_bkkmqmyo', '_TZE200_eaac7dkw']),
        model: 'TS0601_din_1',
        vendor: 'TuYa',
        description: 'Zigbee DIN energy meter',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [tuya.exposes.switch(), e.ac_frequency(), e.energy(), e.power(), e.power_factor(), e.voltage(), e.current(),
            e.produced_energy()],
        meta: {
            tuyaDatapoints: [
                [1, 'energy', tuya.valueConverter.divideBy100],
                [6, null, tuya.valueConverter.phaseVariant1], // voltage and current
                [16, 'state', tuya.valueConverter.onOff],
                [102, 'produced_energy', tuya.valueConverter.divideBy100],
                [103, 'power', tuya.valueConverter.raw],
                [105, 'ac_frequency', tuya.valueConverter.divideBy100],
                [111, 'power_factor', tuya.valueConverter.divideBy10],
                // Ignored for now; we don't know what the values mean
                [109, null, null], // reactive_power in VArh, ignored for now
                [101, null, null], // total active power (translated from chinese) - same as energy dp 1??
                [9, null, null], // Fault - we don't know the possible values here
                [110, null, null], // total reactive power (translated from chinese) - value is 0.03kvar, we already have kvarh on dp 109
                [17, null, null], // Alarm set1 - value seems garbage "AAAAAAAAAAAAAABkAAEOAACqAAAAAAAKAAAAAAAA"
                [18, null, null], // 18 - Alarm set2 - value seems garbage "AAUAZAAFAB4APAAAAAAAAAA="
            ],
        },
        whiteLabel: [{vendor: 'Hiking', model: 'DDS238-2'}, {vendor: 'TuYa', model: 'RC-MCB'}],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_lsanae15', '_TZE204_lsanae15']),
        model: 'TS0601_din_2',
        vendor: 'TuYa',
        description: 'Zigbee DIN energy meter',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [tuya.exposes.switch(), e.energy(), e.power(), e.voltage(), e.current(),
            exposes.enum('fault', ea.STATE, ['clear', 'over_current_threshold', 'over_power_threshold',
                'over_voltage threshold', 'wrong_frequency_threshold']).withDescription('Fault status of the device (clear = nothing)'),
            exposes.enum('threshold_1', ea.STATE, ['not_set', 'over_current_threshold', 'over_voltage_threshold'])
                .withDescription('State of threshold_1'),
            exposes.binary('threshold_1_protection', ea.STATE, 'ON', 'OFF')
                .withDescription('OFF - alarm only, ON - relay will be off when threshold reached'),
            exposes.numeric('threshold_1_value', ea.STATE)
                .withDescription('Can be in Volt or Ampere depending on threshold setting. Setup the value on the device'),
            exposes.enum('threshold_2', ea.STATE, ['not_set', 'over_current_threshold', 'over_voltage_threshold'])
                .withDescription('State of threshold_2'),
            exposes.binary('threshold_2_protection', ea.STATE, 'ON', 'OFF')
                .withDescription('OFF - alarm only, ON - relay will be off when threshold reached'),
            exposes.numeric('threshold_2_value', ea.STATE)
                .withDescription('Setup value on the device'),
            exposes.binary('clear_fault', ea.STATE_SET, 'ON', 'OFF')
                .withDescription('Turn ON to clear last the fault'),
            exposes.text('meter_id', ea.STATE).withDescription('Meter ID (ID of device)'),
        ],
        meta: {
            tuyaDatapoints: [
                [1, 'energy', tuya.valueConverter.divideBy100],
                [3, null, null], // Monthly, but sends data only after request
                [4, null, null], // Dayly, but sends data only after request
                [6, null, tuya.valueConverter.phaseVariant2], // voltage and current
                [10, 'fault', tuya.valueConverterBasic.lookup({'clear': 0, 'over_current_threshold': 1,
                    'over_power_threshold': 2, 'over_voltage_threshold': 4, 'wrong_frequency_threshold': 8})],
                [11, null, null], // Frozen - strange function, in native app - nothing is clear
                [16, 'state', tuya.valueConverter.onOff],
                [17, null, tuya.valueConverter.threshold], // It's settable, but can't write converter
                [18, 'meter_id', tuya.valueConverter.raw],
                [20, 'clear_fault', tuya.valueConverter.onOff], // Clear fault
                [21, null, null], // Forward Energy T1 - don't know what this
                [22, null, null], // Forward Energy T2 - don't know what this
                [23, null, null], // Forward Energy T3 - don't know what this
                [24, null, null], // Forward Energy T4 - don't know what this
            ],
        },
        whiteLabel: [
            tuya.whitelabel('MatSee Plus', 'DAC2161C', 'Smart Zigbee energy meter 80A din rail', ['_TZE200_lsanae15', '_TZE204_lsanae15']),
        ],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_rhblgy0z']),
        model: 'TS0601_din_3',
        vendor: 'TuYa',
        description: 'Zigbee DIN energy meter',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        whiteLabel: [{vendor: 'XOCA', model: 'DAC2161C'}],
        exposes: [tuya.exposes.switch(), e.energy(), e.produced_energy(), e.power(), e.voltage(), e.current(),
            exposes.enum('fault', ea.STATE, ['clear', 'over_current_threshold', 'over_power_threshold',
                'over_voltage threshold', 'wrong_frequency_threshold']).withDescription('Fault status of the device (clear = nothing)'),
            exposes.enum('threshold_1', ea.STATE, ['not_set', 'over_current_threshold', 'over_voltage_threshold'])
                .withDescription('State of threshold_1'),
            exposes.binary('threshold_1_protection', ea.STATE, 'ON', 'OFF')
                .withDescription('OFF - alarm only, ON - relay will be off when threshold reached'),
            exposes.numeric('threshold_1_value', ea.STATE)
                .withDescription('Can be in Volt or Ampere depending on threshold setting. Setup the value on the device'),
            exposes.enum('threshold_2', ea.STATE, ['not_set', 'over_current_threshold', 'over_voltage_threshold'])
                .withDescription('State of threshold_2'),
            exposes.binary('threshold_2_protection', ea.STATE, 'ON', 'OFF')
                .withDescription('OFF - alarm only, ON - relay will be off when threshold reached'),
            exposes.numeric('threshold_2_value', ea.STATE)
                .withDescription('Setup value on the device'),
            exposes.binary('clear_fault', ea.STATE_SET, 'ON', 'OFF')
                .withDescription('Turn ON to clear last the fault'),
            exposes.text('meter_id', ea.STATE).withDescription('Meter ID (ID of device)'),
        ],
        meta: {
            tuyaDatapoints: [
                [1, 'energy', tuya.valueConverter.divideBy100],
                [2, 'produced_energy', tuya.valueConverter.divideBy100],
                [3, null, null], // Monthly, but sends data only after request
                [4, null, null], // Dayly, but sends data only after request
                [6, null, tuya.valueConverter.phaseVariant2], // voltage and current
                [10, 'fault', tuya.valueConverterBasic.lookup({'clear': 0, 'over_current_threshold': 1,
                    'over_power_threshold': 2, 'over_voltage_threshold': 4, 'wrong_frequency_threshold': 8})],
                [11, null, null], // Frozen - strange function, in native app - nothing is clear
                [16, 'state', tuya.valueConverter.onOff],
                [17, null, tuya.valueConverter.threshold], // It's settable, but can't write converter
                [18, 'meter_id', tuya.valueConverter.raw],
                [20, 'clear_fault', tuya.valueConverter.onOff], // Clear fault
                [21, null, null], // Forward Energy T1 - don't know what this
                [22, null, null], // Forward Energy T2 - don't know what this
                [23, null, null], // Forward Energy T3 - don't know what this
                [24, null, null], // Forward Energy T4 - don't know what this
            ],
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_byzdayie'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_fsb6zw01'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_ewxhg6o9'}],
        model: 'TS0601_din',
        vendor: 'TuYa',
        description: 'Zigbee smart energy meter DDS238-2 Zigbee',
        fromZigbee: [fz.tuya_dinrail_switch],
        toZigbee: [tz.tuya_switch_state],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
        },
        exposes: [e.switch().setAccess('state', ea.STATE_SET), e.voltage(), e.power(), e.current(), e.energy()],
    },
    {
        fingerprint: [{modelID: 'TS1101', manufacturerName: '_TZ3000_xfs39dbf'}],
        model: 'TS1101_dimmer_module_1ch',
        vendor: 'TuYa',
        description: 'Zigbee dimmer module 1 channel',
        extend: tuya.extend.light_onoff_brightness({minBrightness: true}),
    },
    {
        fingerprint: [{modelID: 'TS1101', manufacturerName: '_TZ3000_7ysdnebc'}],
        model: 'TS1101_dimmer_module_2ch',
        vendor: 'TuYa',
        description: 'Zigbee dimmer module 2 channel',
        whiteLabel: [{vendor: 'OXT', model: 'SWTZ25'}],
        extend: tuya.extend.light_onoff_brightness({minBrightness: true, endpoints: ['l1', 'l2'], noConfigure: true}),
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await tuya.extend.light_onoff_brightness().configure(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff', 'genLevelCtrl']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff', 'genLevelCtrl']);
        },
    },
    {
        zigbeeModel: ['RH3001'],
        fingerprint: [{type: 'EndDevice', manufacturerID: 4098, applicationVersion: 66, endpoints: [
            {ID: 1, profileID: 260, deviceID: 1026, inputClusters: [0, 10, 1, 1280], outputClusters: [25]},
        ]}],
        model: 'SNTZ007',
        vendor: 'TuYa',
        description: 'Rechargeable Zigbee contact sensor',
        fromZigbee: [fz.ias_contact_alarm_1, fz.battery, fz.ignore_basic_report, fz.ignore_time_read],
        toZigbee: [],
        exposes: [e.contact(), e.battery_low(), e.tamper(), e.battery()],
        whiteLabel: [{vendor: 'BlitzWolf', model: 'BW-IS2'}],
    },
    {
        zigbeeModel: ['RH3040'],
        model: 'RH3040',
        vendor: 'TuYa',
        description: 'PIR sensor',
        fromZigbee: [fz.battery, fz.ignore_basic_report, fz.ias_occupancy_alarm_1],
        toZigbee: [],
        whiteLabel: [{vendor: 'Samotech', model: 'SM301Z'}, {vendor: 'Nedis', model: 'ZBSM10WT'}],
        exposes: [e.battery(), e.occupancy(), e.battery_low(), e.tamper()],
    },
    {
        zigbeeModel: ['TS0115'],
        model: 'TS0115',
        vendor: 'TuYa',
        description: 'Multiprise with 4 AC outlets and 2 USB super charging ports (10A or 16A)',
        extend: tuya.extend.switch({endpoints: ['l1', 'l2', 'l3', 'l4', 'l5']}),
        whiteLabel: [{vendor: 'UseeLink', model: 'SM-SO306E/K/M'}],
        endpoint: (device) => {
            return {l1: 1, l2: 2, l3: 3, l4: 4, l5: 7};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(3), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(4), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(7), coordinatorEndpoint, ['genOnOff']);
            await device.getEndpoint(1).read('genOnOff', ['onOff', 'moesStartUpOnOff']);
            await device.getEndpoint(2).read('genOnOff', ['onOff']);
            await device.getEndpoint(3).read('genOnOff', ['onOff']);
            await device.getEndpoint(4).read('genOnOff', ['onOff']);
            await device.getEndpoint(7).read('genOnOff', ['onOff']);
        },
    },
    {
        zigbeeModel: ['RH3052'],
        model: 'TT001ZAV20',
        vendor: 'TuYa',
        description: 'Temperature & humidity sensor',
        fromZigbee: [fz.humidity, fz.temperature, fz.battery],
        toZigbee: [],
        exposes: [e.humidity(), e.temperature(), e.battery()],
    },
    {
        fingerprint: [{modelID: 'TS0011', manufacturerName: '_TZ3000_l8fsgo6p'}],
        zigbeeModel: ['TS0011'],
        model: 'TS0011',
        vendor: 'TuYa',
        description: 'Smart light switch - 1 gang',
        extend: tuya.extend.switch({backlightModeOffNormalInverted: true}),
        whiteLabel: [
            {vendor: 'Vrey', model: 'VR-X712U-0013'},
            {vendor: 'TUYATEC', model: 'GDKES-01TZXD'},
            {vendor: 'Lonsonho', model: 'QS-Zigbee-S05-L', description: '1 gang smart switch module without neutral wire'},
            {vendor: 'Mercator Ikuü', model: 'SSW01'},
        ],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            // Reports itself as battery which is not correct: https://github.com/Koenkk/zigbee2mqtt/issues/6190
            device.powerSource = 'Mains (single phase)';
            device.save();
        },
    },
    {
        fingerprint: [{modelID: 'TS0011', manufacturerName: '_TZ3000_qmi1cfuq'},
            {modelID: 'TS0011', manufacturerName: '_TZ3000_txpirhfq'}, {modelID: 'TS0011', manufacturerName: '_TZ3000_ji4araar'}],
        model: 'TS0011_switch_module',
        vendor: 'TuYa',
        description: '1 gang switch module - (without neutral)',
        extend: tuya.extend.switch({switchType: true}),
        whiteLabel: [{vendor: 'AVATTO', model: '1gang N-ZLWSM01'}, {vendor: 'SMATRUL', model: 'TMZ02L-16A-W'},
            {vendor: 'Aubess', model: 'TMZ02L-16A-B'}],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            device.powerSource = 'Mains (single phase)';
            device.save();
        },
    },
    {
        zigbeeModel: ['TS0012'],
        model: 'TS0012',
        vendor: 'TuYa',
        description: 'Smart light switch - 2 gang',
        whiteLabel: [{vendor: 'Vrey', model: 'VR-X712U-0013'}, {vendor: 'TUYATEC', model: 'GDKES-02TZXD'},
            {vendor: 'Earda', model: 'ESW-2ZAA-EU'}, {vendor: 'Moes', model: 'ZS-US2-WH-MS'}, {vendor: 'Moes', model: 'ZS-US2-BK-MS'}],
        extend: tuya.extend.switch({backlightModeOffNormalInverted: true, endpoints: ['left', 'right']}),
        endpoint: (device) => {
            return {'left': 1, 'right': 2};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            device.powerSource = 'Mains (single phase)';
            device.save();
        },
    },
    {
        fingerprint: [{modelID: 'TS0012', manufacturerName: '_TZ3000_jl7qyupf'},
            {modelID: 'TS0012', manufacturerName: '_TZ3000_nPGIPl5D'},
            {modelID: 'TS0012', manufacturerName: '_TZ3000_4zf0crgo'}],
        model: 'TS0012_switch_module',
        vendor: 'TuYa',
        description: '2 gang switch module - (without neutral)',
        whiteLabel: [{vendor: 'AVATTO', model: '2gang N-ZLWSM01'}],
        extend: tuya.extend.switch({switchType: true, endpoints: ['left', 'right']}),
        endpoint: (device) => {
            return {'left': 1, 'right': 2};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            device.powerSource = 'Mains (single phase)';
            device.save();
        },
    },
    {
        zigbeeModel: ['TS0013'],
        model: 'TS0013',
        vendor: 'TuYa',
        description: 'Smart light switch - 3 gang without neutral wire',
        extend: tuya.extend.switch({backlightModeLowMediumHigh: true, endpoints: ['left', 'center', 'right']}),
        endpoint: (device) => {
            return {'left': 1, 'center': 2, 'right': 3};
        },
        whiteLabel: [{vendor: 'TUYATEC', model: 'GDKES-03TZXD'}],
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            try {
                for (const ID of [1, 2, 3]) {
                    const endpoint = device.getEndpoint(ID);
                    await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
                }
            } catch (e) {
                // Fails for some: https://github.com/Koenkk/zigbee2mqtt/issues/4872
            }
            device.powerSource = 'Mains (single phase)';
            device.save();
        },
    },
    {
        fingerprint: [{modelID: 'TS0013', manufacturerName: '_TZ3000_ypgri8yz'}],
        model: 'TS0013_switch_module',
        vendor: 'TuYa',
        description: '3 gang switch module - (without neutral)',
        whiteLabel: [{vendor: 'AVATTO', model: '3gang N-ZLWSM01'}],
        extend: tuya.extend.switch({switchType: true, endpoints: ['left', 'center', 'right']}),
        endpoint: (device) => {
            return {'left': 1, 'center': 2, 'right': 3};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            try {
                for (const ID of [1, 2, 3]) {
                    const endpoint = device.getEndpoint(ID);
                    await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
                }
            } catch (e) {
                // Fails for some: https://github.com/Koenkk/zigbee2mqtt/issues/4872
            }
            device.powerSource = 'Mains (single phase)';
            device.save();
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0014', ['_TZ3000_jr2atpww', '_TYZB01_dvakyzhd', '_TZ3000_mrduubod',
            '_TZ3210_w3hl6rao', '_TYZB01_bagt1e4o', '_TZ3000_r0pmi2p3', '_TZ3000_fxjdcikv', '_TZ3000_q6vxaod1']),
        model: 'TS0014',
        vendor: 'TuYa',
        description: 'Smart light switch - 4 gang without neutral wire',
        extend: tuya.extend.switch({backlightModeLowMediumHigh: true, endpoints: ['l1', 'l2', 'l3', 'l4']}),
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2, 'l3': 3, 'l4': 4};
        },
        whiteLabel: [{vendor: 'TUYATEC', model: 'GDKES-04TZXD'}, {vendor: 'Vizo', model: 'VZ-222S'},
            {vendor: 'MakeGood', model: 'MG-ZG04W/B/G'}, {vendor: 'Mercator Ikuü', model: 'SSW04'}],
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            try {
                for (const ID of [1, 2, 3, 4]) {
                    const endpoint = device.getEndpoint(ID);
                    await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
                }
            } catch (e) {
                // Fails for some: https://github.com/Koenkk/zigbee2mqtt/issues/4872
            }
            device.powerSource = 'Mains (single phase)';
            device.save();
        },
    },
    {
        zigbeeModel: ['gq8b1uv'],
        model: 'gq8b1uv',
        vendor: 'TuYa',
        description: 'Zigbee smart dimmer',
        fromZigbee: [fz.tuya_dimmer, fz.ignore_basic_report],
        toZigbee: [tz.tuya_dimmer_state, tz.tuya_dimmer_level],
        exposes: [e.light_brightness().setAccess('state', ea.STATE_SET).setAccess('brightness', ea.STATE_SET)],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'genLevelCtrl']);
        },
    },
    {
        zigbeeModel: ['HY0017', '005f0c3b'],
        model: 'U86KCJ-ZP',
        vendor: 'TuYa',
        description: 'Smart 6 key scene wall switch',
        fromZigbee: [fzLocal.scenes_recall_scene_65029],
        exposes: [e.action(['scene_1', 'scene_2', 'scene_3', 'scene_4', 'scene_5', 'scene_6'])],
        toZigbee: [],
    },
    {
        zigbeeModel: ['TS0026'],
        model: 'TS0026',
        vendor: 'TuYa',
        description: '6 button scene wall switch',
        fromZigbee: [fzLocal.scenes_recall_scene_65029],
        exposes: [e.action(['scene_1', 'scene_2', 'scene_3', 'scene_4', 'scene_5', 'scene_6'])],
        toZigbee: [],
    },
    {
        zigbeeModel: ['q9mpfhw'],
        model: 'SNTZ009',
        vendor: 'TuYa',
        description: 'Water leak sensor',
        fromZigbee: [fz.tuya_water_leak, fz.ignore_basic_report],
        exposes: [e.water_leak()],
        toZigbee: [],
    },
    {
        zigbeeModel: ['TS0004'],
        model: 'TS0004',
        vendor: 'TuYa',
        description: 'Smart light switch - 4 gang with neutral wire',
        extend: tuya.extend.switch({powerOnBehavior2: true, endpoints: ['l1', 'l2', 'l3', 'l4']}),
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2, 'l3': 3, 'l4': 4};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(3), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(4), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        zigbeeModel: ['TS0726'],
        model: 'TS0726',
        vendor: 'TuYa',
        description: '4 gang switch with neutral wire',
        extend: tuya.extend.switch({powerOnBehavior2: true, endpoints: ['l1', 'l2', 'l3', 'l4']}),
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2, 'l3': 3, 'l4': 4};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(3), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(4), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        fingerprint: [{modelID: 'TS0006', manufacturerName: '_TYZB01_ltundz9m'},
            {modelID: 'TS0006', manufacturerName: '_TZ3000_jyupj3fw'}],
        model: 'TS0006',
        vendor: 'TuYa',
        description: '6 gang switch module with neutral wire',
        extend: tuya.extend.switch(),
        exposes: [e.switch().withEndpoint('l1'), e.switch().withEndpoint('l2'), e.switch().withEndpoint('l3'),
            e.switch().withEndpoint('l4'), e.switch().withEndpoint('l5'), e.switch().withEndpoint('l6')],
        endpoint: (device) => {
            return {'l1': 1, 'l2': 2, 'l3': 3, 'l4': 4, 'l5': 5, 'l6': 6};
        },
        meta: {multiEndpoint: true},
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(3), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(4), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(5), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(6), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        zigbeeModel: ['HY0080'],
        model: 'U86KWF-ZPSJ',
        vendor: 'TuYa',
        description: 'Environment controller',
        fromZigbee: [fz.legacy.thermostat_att_report, fz.fan],
        toZigbee: [tz.thermostat_local_temperature, tz.thermostat_local_temperature_calibration,
            tz.thermostat_occupancy, tz.thermostat_occupied_heating_setpoint, tz.thermostat_unoccupied_heating_setpoint,
            tz.thermostat_occupied_cooling_setpoint, tz.thermostat_unoccupied_cooling_setpoint,
            tz.thermostat_setpoint_raise_lower, tz.thermostat_remote_sensing,
            tz.thermostat_control_sequence_of_operation, tz.thermostat_system_mode, tz.thermostat_weekly_schedule,
            tz.thermostat_clear_weekly_schedule, tz.thermostat_relay_status_log,
            tz.thermostat_temperature_setpoint_hold, tz.thermostat_temperature_setpoint_hold_duration, tz.fan_mode],
        exposes: [exposes.climate().withSetpoint('occupied_heating_setpoint', 5, 30, 0.5).withLocalTemperature()
            .withSystemMode(['off', 'auto', 'heat'], ea.ALL)
            .withRunningState(['idle', 'heat', 'cool'], ea.STATE)
            .withLocalTemperatureCalibration(-30, 30, 0.1, ea.ALL).withPiHeatingDemand()],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(9);
            await reporting.bind(endpoint, coordinatorEndpoint, ['hvacThermostat', 'hvacFanCtrl']);
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatSystemMode(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatUnoccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatOccupiedCoolingSetpoint(endpoint);
            await reporting.thermostatUnoccupiedCoolingSetpoint(endpoint);
            await reporting.fanMode(endpoint);
        },
    },
    {
        zigbeeModel: ['6dfgetq'],
        model: 'D3-DPWK-TY',
        vendor: 'TuYa',
        description: 'HVAC controller',
        exposes: [exposes.climate().withSetpoint('current_heating_setpoint', 5, 30, 0.5, ea.STATE_SET)
            .withLocalTemperature(ea.STATE)
            .withSystemMode(['off', 'auto', 'heat'], ea.STATE_SET)
            .withRunningState(['idle', 'heat', 'cool'], ea.STATE)],
        fromZigbee: [fz.tuya_thermostat, fz.ignore_basic_report, fz.tuya_dimmer],
        meta: {tuyaThermostatSystemMode: tuya.thermostatSystemModes2, tuyaThermostatPreset: tuya.thermostatPresets},
        toZigbee: [tz.tuya_thermostat_current_heating_setpoint, tz.tuya_thermostat_system_mode,
            tz.tuya_thermostat_fan_mode, tz.tuya_dimmer_state],
    },
    {
        zigbeeModel: ['E220-KR4N0Z0-HA', 'JZ-ZB-004'],
        model: 'E220-KR4N0Z0-HA',
        vendor: 'TuYa',
        description: 'Multiprise with 4 AC outlets and 2 USB super charging ports (16A)',
        extend: tuya.extend.switch(),
        fromZigbee: [fz.on_off_skip_duplicate_transaction],
        exposes: [e.switch().withEndpoint('l1'), e.switch().withEndpoint('l2'), e.switch().withEndpoint('l3'),
            e.switch().withEndpoint('l4')],
        whiteLabel: [{vendor: 'LEELKI', model: 'WP33-EU'}],
        meta: {multiEndpoint: true},
        endpoint: (device) => {
            return {l1: 1, l2: 2, l3: 3, l4: 4};
        },
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(3), coordinatorEndpoint, ['genOnOff']);
            await reporting.bind(device.getEndpoint(4), coordinatorEndpoint, ['genOnOff']);
        },
    },
    {
        zigbeeModel: ['TS0216'],
        model: 'TS0216',
        vendor: 'TuYa',
        description: 'Sound and flash siren',
        fromZigbee: [fz.ts0216_siren, fz.battery],
        exposes: [e.battery(), exposes.binary('alarm', ea.STATE_SET, true, false),
            exposes.numeric('volume', ea.ALL).withValueMin(0).withValueMax(100).withDescription('Volume of siren')],
        toZigbee: [tz.ts0216_alarm, tz.ts0216_duration, tz.ts0216_volume],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            // Device advertises itself as Router but is an EndDevice
            device.type = 'EndDevice';
            device.save();
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_znzs7yaw'}],
        model: 'HY08WE',
        vendor: 'TuYa',
        description: 'Wall-mount thermostat',
        fromZigbee: [fz.hy_thermostat, fz.ignore_basic_report],
        toZigbee: [tz.hy_thermostat],
        onEvent: tuya.onEventSetTime,
        exposes: [exposes.climate().withSetpoint('current_heating_setpoint', 5, 30, 0.5, ea.STATE_SET)
            .withLocalTemperature(ea.STATE)
            .withSystemMode(['off', 'auto', 'heat'], ea.STATE_SET).withRunningState(['idle', 'heat'], ea.STATE)],
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_2ekuz3dz'}],
        model: 'X5H-GB-B',
        vendor: 'TuYa',
        description: 'Wall-mount thermostat',
        fromZigbee: [fz.ignore_basic_report, fzLocal.x5h_thermostat],
        toZigbee: [tzLocal.x5h_thermostat],
        whiteLabel: [{vendor: 'Beok', model: 'TGR85-ZB'}],
        exposes: [
            exposes.climate().withSetpoint('current_heating_setpoint', 5, 60, 0.5, ea.STATE_SET)
                .withLocalTemperature(ea.STATE).withLocalTemperatureCalibration(-9.9, 9.9, 0.1, ea.STATE_SET)
                .withSystemMode(['off', 'heat'], ea.STATE_SET).withRunningState(['idle', 'heat'], ea.STATE)
                .withPreset(['manual', 'program']),
            e.temperature_sensor_select(['internal', 'external', 'both']),
            exposes.text('schedule', ea.STATE_SET).withDescription('There are 8 periods in the schedule in total. ' +
                '6 for workdays and 2 for holidays. It should be set in the following format for each of the periods: ' +
                '`hours:minutes/temperature`. All periods should be set at once and delimited by the space symbol. ' +
                'For example: `06:00/20.5 08:00/15 11:30/15 13:30/15 17:00/22 22:00/15 06:00/20 22:00/15`. ' +
                'The thermostat doesn\'t report the schedule by itself even if you change it manually from device'),
            e.child_lock(), e.week(),
            exposes.enum('brightness_state', ea.STATE_SET, ['off', 'low', 'medium', 'high'])
                .withDescription('Screen brightness'),
            exposes.binary('sound', ea.STATE_SET, 'ON', 'OFF')
                .withDescription('Switches beep sound when interacting with thermostat'),
            exposes.binary('frost_protection', ea.STATE_SET, 'ON', 'OFF')
                .withDescription('Antifreeze function'),
            exposes.binary('factory_reset', ea.STATE_SET, 'ON', 'OFF')
                .withDescription('Resets all settings to default. Doesn\'t unpair device.'),
            exposes.numeric('heating_temp_limit', ea.STATE_SET).withUnit('°C').withValueMax(60)
                .withValueMin(5).withValueStep(1).withPreset('default', 35, 'Default value')
                .withDescription('Heating temperature limit'),
            exposes.numeric('deadzone_temperature', ea.STATE_SET).withUnit('°C').withValueMax(9.5)
                .withValueMin(0.5).withValueStep(0.5).withPreset('default', 1, 'Default value')
                .withDescription('The delta between local_temperature and current_heating_setpoint to trigger Heat'),
            exposes.numeric('upper_temp', ea.STATE_SET).withUnit('°C').withValueMax(95)
                .withValueMin(35).withValueStep(1).withPreset('default', 60, 'Default value'),
        ],
        onEvent: tuya.onEventSetTime,
    },
    {
        fingerprint: [{modelID: 'TS0222', manufacturerName: '_TYZB01_4mdqxxnn'},
            {modelID: 'TS0222', manufacturerName: '_TYZB01_m6ec2pgj'}],
        model: 'TS0222',
        vendor: 'TuYa',
        description: 'Light intensity sensor',
        fromZigbee: [fz.battery, fz.illuminance, fzLocal.TS0222],
        toZigbee: [],
        exposes: [e.battery(), e.illuminance(), e.illuminance_lux()],
        configure: tuya.configureMagicPacket,
    },
    {
        fingerprint: [{modelID: 'TS0210', manufacturerName: '_TYZB01_3zv6oleo'},
            {modelID: 'TS0210', manufacturerName: '_TYZB01_j9xxahcl'},
            {modelID: 'TS0210', manufacturerName: '_TYZB01_kulduhbj'},
            {modelID: 'TS0210', manufacturerName: '_TYZB01_cc3jzhlj'},
            {modelID: 'TS0210', manufacturerName: '_TZ3000_bmfw9ykl'},
            {modelID: 'TS0210', manufacturerName: '_TYZB01_geigpsy4'},
            {modelID: 'TS0210', manufacturerName: '_TZ3000_fkxmyics'}],
        model: 'TS0210',
        vendor: 'TuYa',
        description: 'Vibration sensor',
        fromZigbee: [fz.battery, fz.ias_vibration_alarm_1_with_timeout],
        toZigbee: [tz.TS0210_sensitivity],
        exposes: [e.battery(), e.battery_voltage(), e.vibration(), exposes.enum('sensitivity', ea.STATE_SET, ['low', 'medium', 'high'])],
    },
    {
        fingerprint: [{modelID: 'TS011F', manufacturerName: '_TZ3000_8bxrzyxz'},
            {modelID: 'TS011F', manufacturerName: '_TZ3000_ky0fq4ho'}, {modelID: 'TS011F', manufacturerName: '_TZ3000_qeuvnohg'}],
        model: 'TS011F_din_smart_relay',
        description: 'Din smart relay (with power monitoring)',
        vendor: 'TuYa',
        fromZigbee: [fz.on_off, fz.electrical_measurement, fz.metering, fz.ignore_basic_report, tuya.fz.power_outage_memory,
            fz.tuya_relay_din_led_indicator],
        toZigbee: [tz.on_off, tuya.tz.power_on_behavior_1, tz.tuya_relay_din_led_indicator],
        whiteLabel: [{vendor: 'MatSee Plus', model: 'ATMS1602Z'}, {vendor: 'Tongou', model: 'TO-Q-SY1-JZT'}],
        ota: ota.zigbeeOTA,
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'haElectricalMeasurement', 'seMetering']);
            await reporting.rmsVoltage(endpoint, {change: 5});
            await reporting.rmsCurrent(endpoint, {change: 50});
            await reporting.activePower(endpoint, {change: 10});
            await reporting.currentSummDelivered(endpoint);
            endpoint.saveClusterAttributeKeyValue('haElectricalMeasurement', {acCurrentDivisor: 1000, acCurrentMultiplier: 1});
            endpoint.saveClusterAttributeKeyValue('seMetering', {divisor: 100, multiplier: 1});
            device.save();
        },
        exposes: [e.switch(), e.power(), e.current(), e.voltage(),
            e.energy(), exposes.enum('power_outage_memory', ea.ALL, ['on', 'off', 'restore'])
                .withDescription('Recover state after power outage'),
            exposes.enum('indicator_mode', ea.STATE_SET, ['off', 'on_off', 'off_on'])
                .withDescription('Relay LED indicator mode')],
    },
    {
        fingerprint: [{modelID: 'TS011F', manufacturerName: '_TZ3000_7issjl2q'}],
        model: 'ATMS1601Z',
        description: 'Din smart relay (without power monitoring)',
        vendor: 'TuYa',
        fromZigbee: [fz.on_off, fz.ignore_basic_report, tuya.fz.power_outage_memory, fz.tuya_relay_din_led_indicator],
        toZigbee: [tz.on_off, tuya.tz.power_on_behavior_1, tz.tuya_relay_din_led_indicator],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
            device.save();
        },
        exposes: [e.switch(),
            exposes.enum('power_outage_memory', ea.ALL, ['on', 'off', 'restore'])
                .withDescription('Recover state after power outage'),
            exposes.enum('indicator_mode', ea.STATE_SET, ['off', 'on_off', 'off_on'])
                .withDescription('Relay LED indicator mode')],
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_nklqjk62'}],
        model: 'PJ-ZGD01',
        vendor: 'TuYa',
        description: 'Garage door opener',
        fromZigbee: [fz.matsee_garage_door_opener, fz.ignore_basic_report],
        toZigbee: [tz.matsee_garage_door_opener, tz.tuya_data_point_test],
        whiteLabel: [{vendor: 'MatSee Plus', model: 'PJ-ZGD01'}],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genBasic']);
        },
        exposes: [exposes.binary('trigger', ea.STATE_SET, true, false).withDescription('Trigger the door movement'),
            exposes.binary('garage_door_contact', ea.STATE, true, false)],
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_wfxuhoea'}],
        model: 'GDC311ZBQ1',
        vendor: 'TuYa',
        description: 'LoraTap garage door opener with wireless sensor',
        fromZigbee: [fz.matsee_garage_door_opener, fz.ignore_basic_report],
        toZigbee: [tz.matsee_garage_door_opener, tz.tuya_data_point_test],
        whiteLabel: [{vendor: 'LoraTap', model: 'GDC311ZBQ1'}],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genBasic']);
        },
        exposes: [exposes.binary('trigger', ea.STATE_SET, true, false).withDescription('Trigger the door movement'),
            exposes.binary('garage_door_contact', ea.STATE, false, true)
                .withDescription('Indicates if the garage door contact is closed (= true) or open (= false)')],
    },
    {
        fingerprint: [{modelID: 'TS0201', manufacturerName: '_TZ3000_qaaysllp'}],
        model: 'LCZ030',
        vendor: 'TuYa',
        description: 'Temperature & humidity & illuminance sensor with display',
        fromZigbee: [fz.battery, fz.illuminance, fz.temperature, fz.humidity, fz.ts0201_temperature_humidity_alarm],
        toZigbee: [tz.ts0201_temperature_humidity_alarm],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            // Enables reporting of measurement state changes
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genBasic', 'genPowerCfg',
                'msTemperatureMeasurement', 'msIlluminanceMeasurement', 'msRelativeHumidity', 'manuSpecificTuya_2']);
        },
        exposes: [e.temperature(), e.humidity(), e.battery(), e.illuminance(), e.illuminance_lux(),
            exposes.numeric('alarm_temperature_max', ea.STATE_SET).withUnit('°C').withDescription('Alarm temperature max')
                .withValueMin(-20).withValueMax(80),
            exposes.numeric('alarm_temperature_min', ea.STATE_SET).withUnit('°C').withDescription('Alarm temperature min')
                .withValueMin(-20).withValueMax(80),
            exposes.numeric('alarm_humidity_max', ea.STATE_SET).withUnit('%').withDescription('Alarm humidity max')
                .withValueMin(0).withValueMax(100),
            exposes.numeric('alarm_humidity_min', ea.STATE_SET).withUnit('%').withDescription('Alarm humidity min')
                .withValueMin(0).withValueMax(100),
            exposes.enum('alarm_humidity', ea.STATE, ['below_min_humdity', 'over_humidity', 'off'])
                .withDescription('Alarm humidity status'),
            exposes.enum('alarm_temperature', ea.STATE, ['below_min_temperature', 'over_temperature', 'off'])
                .withDescription('Alarm temperature status'),
        ],
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_auin8mzr'}],
        model: 'TS0601_motion_sensor',
        vendor: 'TuYa',
        description: 'Human presence sensor AIR',
        fromZigbee: [fz.tuya_motion_sensor],
        toZigbee: [tz.tuya_motion_sensor],
        exposes: [
            e.occupancy(),
            exposes.enum('o_sensitivity', ea.STATE_SET, Object.values(tuya.msLookups.OSensitivity)).withDescription('O-Sensitivity mode'),
            exposes.enum('v_sensitivity', ea.STATE_SET, Object.values(tuya.msLookups.VSensitivity)).withDescription('V-Sensitivity mode'),
            exposes.enum('led_status', ea.STATE_SET, ['ON', 'OFF']).withDescription('Led status switch'),
            exposes.numeric('vacancy_delay', ea.STATE_SET).withUnit('sec').withDescription('Vacancy delay').withValueMin(0)
                .withValueMax(1000),
            exposes.numeric('light_on_luminance_prefer', ea.STATE_SET).withDescription('Light-On luminance prefer')
                .withValueMin(0).withValueMax(10000),
            exposes.numeric('light_off_luminance_prefer', ea.STATE_SET).withDescription('Light-Off luminance prefer')
                .withValueMin(0).withValueMax(10000),
            exposes.enum('mode', ea.STATE_SET, Object.values(tuya.msLookups.Mode)).withDescription('Working mode'),
            exposes.numeric('luminance_level', ea.STATE).withDescription('Luminance level'),
            exposes.numeric('reference_luminance', ea.STATE).withDescription('Reference luminance'),
            exposes.numeric('vacant_confirm_time', ea.STATE).withDescription('Vacant confirm time'),
        ],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_lu01t0zl', '_TZE200_vrfecyku']),
        model: 'MIR-HE200-TY',
        vendor: 'TuYa',
        description: 'Human presence sensor with fall function',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await tuya.sendDataPointEnum(endpoint, tuya.dataPoints.trsfTumbleSwitch, false);
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
        },
        exposes: [
            e.illuminance_lux(), e.presence(), e.occupancy(),
            exposes.numeric('motion_speed', ea.STATE).withDescription('Speed of movement'),
            exposes.enum('motion_direction', ea.STATE, ['standing_still', 'moving_forward', 'moving_backward'])
                .withDescription('direction of movement from the point of view of the radar'),
            exposes.numeric('radar_sensitivity', ea.STATE_SET).withValueMin(0).withValueMax(10).withValueStep(1)
                .withDescription('Sensitivity of the radar'),
            exposes.enum('radar_scene', ea.STATE_SET, ['default', 'area', 'toilet', 'bedroom', 'parlour', 'office', 'hotel'])
                .withDescription('Presets for sensitivity for presence and movement'),
            exposes.enum('tumble_switch', ea.STATE_SET, ['ON', 'OFF']).withDescription('Tumble status switch'),
            exposes.numeric('fall_sensitivity', ea.STATE_SET).withValueMin(1).withValueMax(10).withValueStep(1)
                .withDescription('Fall sensitivity of the radar'),
            exposes.numeric('tumble_alarm_time', ea.STATE_SET).withValueMin(1).withValueMax(5).withValueStep(1)
                .withUnit('min').withDescription('Tumble alarm time'),
            exposes.enum('fall_down_status', ea.STATE, ['none', 'maybe_fall', 'fall'])
                .withDescription('Fall down status'),
            exposes.text('static_dwell_alarm', ea.STATE).withDescription('Static dwell alarm'),
        ],
        meta: {
            tuyaDatapoints: [
                [1, 'presence', tuya.valueConverter.trueFalse1],
                [2, 'radar_sensitivity', tuya.valueConverter.raw],
                [102, 'occupancy', tuya.valueConverter.trueFalse1],
                [103, 'illuminance_lux', tuya.valueConverter.raw],
                [105, 'tumble_switch', tuya.valueConverter.plus1],
                [106, 'tumble_alarm_time', tuya.valueConverter.raw],
                [112, 'radar_scene', tuya.valueConverterBasic.lookup(
                    {'default': 0, 'area': 1, 'toilet': 2, 'bedroom': 3, 'parlour': 4, 'office': 5, 'hotel': 6})],
                [114, 'motion_direction', tuya.valueConverterBasic.lookup(
                    {'standing_still': 0, 'moving_forward': 1, 'moving_backward': 2})],
                [115, 'motion_speed', tuya.valueConverter.raw],
                [116, 'fall_down_status', tuya.valueConverterBasic.lookup({'none': 0, 'maybe_fall': 1, 'fall': 2})],
                [117, 'static_dwell_alarm', tuya.valueConverter.raw],
                [118, 'fall_sensitivity', tuya.valueConverter.raw],
                // Below are ignored
                [101, null, null], // reset_flag_code
                [104, null, null], // detection_flag_code
                [107, null, null], // radar_check_end_code
                [108, null, null], // radar_check_start_code
                [109, null, null], // hw_version_code
                [110, null, null], // sw_version_code
                [111, null, null], // radar_id_code
            ],
        },
    },
    {
        zigbeeModel: ['TS0046'],
        model: 'TS0046',
        vendor: 'TuYa',
        description: 'Wireless switch with 6 buttons',
        whiteLabel: [{vendor: 'LoraTap', model: 'SS9600ZB'}],
        fromZigbee: [fz.tuya_on_off_action, fz.battery],
        exposes: [e.battery(), e.action(['1_single', '1_double', '1_hold', '2_single', '2_double', '2_hold',
            '3_single', '3_double', '3_hold', '4_single', '4_double', '4_hold',
            '5_single', '5_double', '5_hold', '6_single', '6_double', '6_hold'])],
        toZigbee: [],
        configure: tuya.configureMagicPacket,
    },
    {
        fingerprint: [{modelID: 'TS004F', manufacturerName: '_TZ3000_pcqjmcud'}],
        model: 'YSR-MINI-Z',
        vendor: 'TuYa',
        description: '2 in 1 dimming remote control and scene control',
        exposes: [
            e.battery(),
            e.action(['on', 'off',
                'brightness_move_up', 'brightness_step_up', 'brightness_step_down', 'brightness_move_down', 'brightness_stop',
                'color_temperature_step_down', 'color_temperature_step_up',
                '1_single', '1_double', '1_hold', '2_single', '2_double', '2_hold',
                '3_single', '3_double', '3_hold', '4_single', '4_double', '4_hold',
            ]),
            exposes.enum('operation_mode', ea.ALL, ['command', 'event']).withDescription(
                'Operation mode: "command" - for group control, "event" - for clicks'),
        ],
        fromZigbee: [fz.battery, fz.command_on, fz.command_off, fz.command_step, fz.command_move, fz.command_stop,
            fz.command_step_color_temperature, fz.tuya_on_off_action, fz.tuya_operation_mode],
        toZigbee: [tz.tuya_operation_mode],
        onEvent: tuya.onEventSetLocalTime,
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await endpoint.read('genBasic', [0x0004, 0x000, 0x0001, 0x0005, 0x0007, 0xfffe]);
            await endpoint.write('genOnOff', {'tuyaOperationMode': 1});
            await endpoint.read('genOnOff', ['tuyaOperationMode']);
            try {
                await endpoint.read(0xE001, [0xD011]);
            } catch (err) {/* do nothing */}
            await endpoint.read('genPowerCfg', ['batteryVoltage', 'batteryPercentageRemaining']);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
            await reporting.batteryPercentageRemaining(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_hkdl5fmv'}],
        model: 'TS0601_rcbo',
        vendor: 'TuYa',
        whiteLabel: [
            {vendor: 'HOCH', model: 'ZJSBL7-100Z'},
            {vendor: 'WDYK', model: 'ZJSBL7-100Z'},
        ],
        description: 'DIN mount RCBO with smart energy metering',
        fromZigbee: [fz.hoch_din],
        toZigbee: [tz.hoch_din],
        exposes: [
            exposes.text('meter_number', ea.STATE),
            exposes.binary('state', ea.STATE_SET, 'ON', 'OFF'),
            exposes.text('alarm', ea.STATE),
            exposes.binary('trip', ea.STATE_SET, 'trip', 'clear'),
            exposes.binary('child_lock', ea.STATE_SET, 'ON', 'OFF'),
            exposes.enum('power_on_behavior', ea.STATE_SET, ['off', 'on', 'previous']),
            exposes.numeric('countdown_timer', ea.STATE_SET).withValueMin(0).withValueMax(86400).withUnit('s'),
            exposes.numeric('voltage_rms', ea.STATE).withUnit('V'),
            exposes.numeric('current', ea.STATE).withUnit('A'),
            exposes.numeric('current_average', ea.STATE).withUnit('A'),
            e.power(), e.voltage(), e.energy(), e.temperature(),
            exposes.numeric('energy_consumed', ea.STATE).withUnit('kWh'),
            exposes.enum('clear_device_data', ea.SET, ['']),
        ],
    },
    {
        fingerprint: [{modelID: 'TS004F', manufacturerName: '_TZ3000_4fjiwweb'}, {modelID: 'TS004F', manufacturerName: '_TZ3000_uri7ongn'},
            {modelID: 'TS004F', manufacturerName: '_TZ3000_ixla93vd'}, {modelID: 'TS004F', manufacturerName: '_TZ3000_qja6nq5z'}],
        model: 'ERS-10TZBVK-AA',
        vendor: 'TuYa',
        description: 'Smart knob',
        fromZigbee: [
            fz.command_step, fz.command_toggle, fz.command_move_hue, fz.command_step_color_temperature, fz.command_stop_move_raw,
            fz.tuya_multi_action, fz.tuya_operation_mode, fz.battery,
        ],
        toZigbee: [tz.tuya_operation_mode],
        exposes: [
            e.action([
                'toggle', 'brightness_step_up', 'brightness_step_down', 'color_temperature_step_up', 'color_temperature_step_down',
                'saturation_move', 'hue_move', 'hue_stop', 'single', 'double', 'hold', 'rotate_left', 'rotate_right',
            ]),
            exposes.numeric('action_step_size', ea.STATE).withValueMin(0).withValueMax(255),
            exposes.numeric('action_transition_time', ea.STATE).withUnit('s'),
            exposes.numeric('action_rate', ea.STATE).withValueMin(0).withValueMax(255),
            e.battery(),
            exposes.enum('operation_mode', ea.ALL, ['command', 'event']).withDescription(
                'Operation mode: "command" - for group control, "event" - for clicks'),
        ],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await endpoint.read('genBasic', [0x0004, 0x000, 0x0001, 0x0005, 0x0007, 0xfffe]);
            await endpoint.write('genOnOff', {'tuyaOperationMode': 1});
            await endpoint.read('genOnOff', ['tuyaOperationMode']);
            try {
                await endpoint.read(0xE001, [0xD011]);
            } catch (err) {/* do nothing */}
            await endpoint.read('genPowerCfg', ['batteryVoltage', 'batteryPercentageRemaining']);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
            await reporting.batteryPercentageRemaining(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_kzm5w4iz'}],
        model: 'TS0601_vibration_sensor',
        vendor: 'TuYa',
        description: 'Smart vibration sensor',
        fromZigbee: [fz.tuya_smart_vibration_sensor],
        toZigbee: [],
        exposes: [e.contact(), e.battery(), e.vibration()],
    },
    {
        fingerprint: [{modelID: `TS0601`, manufacturerName: `_TZE200_yi4jtqq1`}, {modelID: `TS0601`, manufacturerName: `_TZE200_khx7nnka`}],
        model: `XFY-CGQ-ZIGB`,
        vendor: `TuYa`,
        description: `Illuminance sensor`,
        fromZigbee: [fz.tuya_illuminance_sensor],
        toZigbee: [],
        exposes: [e.illuminance_lux(), e.brightness_state()],
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_kltffuzl'}, {modelID: 'TS0601', manufacturerName: '_TZE200_fwoorn8y'}],
        model: 'TM001-ZA/TM081',
        vendor: 'TuYa',
        description: 'Door and window sensor',
        fromZigbee: [fz.tm081],
        toZigbee: [],
        exposes: [e.contact(), e.battery()],
    },
    {
        fingerprint: [{modelID: `TS0601`, manufacturerName: `_TZE200_2m38mh6k`}],
        model: 'SS9600ZB',
        vendor: 'TuYa',
        description: '6 gang remote',
        exposes: [e.battery(),
            e.action(['1_single', '1_double', '1_hold', '2_single', '2_double', '2_hold', '3_single', '3_double', '3_hold',
                '4_single', '4_double', '4_hold', '5_single', '5_double', '5_hold', '6_single', '6_double', '6_hold'])],
        fromZigbee: [fz.tuya_remote],
        toZigbee: [],
    },
    {
        zigbeeModel: ['TS0052'],
        model: 'TS0052',
        vendor: 'TuYa',
        description: 'Zigbee dimmer module 1 channel',
        extend: tuya.extend.light_onoff_brightness(),
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_ikvncluo'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_lyetpprm'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_jva8ink8'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_holel4dk'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_xpq2rzhq'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_wukb7rhc'},
            {modelID: 'TS0601', manufacturerName: '_TZE204_ztc6ggyl'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_ztc6ggyl'}],
        model: 'TS0601_smart_human_presence_sensor',
        vendor: 'TuYa',
        description: 'Smart Human presence sensor',
        fromZigbee: [fz.tuya_smart_human_presense_sensor],
        toZigbee: [tz.tuya_smart_human_presense_sensor],
        exposes: [
            e.illuminance_lux(), e.presence(),
            exposes.numeric('target_distance', ea.STATE).withDescription('Distance to target').withUnit('m'),
            exposes.numeric('radar_sensitivity', ea.STATE_SET).withValueMin(0).withValueMax(9).withValueStep(1)
                .withDescription('sensitivity of the radar'),
            exposes.numeric('minimum_range', ea.STATE_SET).withValueMin(0).withValueMax(9.5).withValueStep(0.15)
                .withDescription('Minimum range').withUnit('m'),
            exposes.numeric('maximum_range', ea.STATE_SET).withValueMin(0).withValueMax(9.5).withValueStep(0.15)
                .withDescription('Maximum range').withUnit('m'),
            exposes.numeric('detection_delay', ea.STATE_SET).withValueMin(0).withValueMax(10).withValueStep(0.1)
                .withDescription('Detection delay').withUnit('s'),
            exposes.numeric('fading_time', ea.STATE_SET).withValueMin(0).withValueMax(1500).withValueStep(1)
                .withDescription('Fading time').withUnit('s'),
            // exposes.text('cli', ea.STATE).withDescription('not recognize'),
            exposes.enum('self_test', ea.STATE, Object.values(tuya.tuyaHPSCheckingResult))
                .withDescription('Self_test, possible resuts: checking, check_success, check_failure, others, comm_fault, radar_fault.'),
        ],
        whiteLabel: [
            tuya.whitelabel('TuYa', 'ZY-M100-S', 'Human presence sensor', ['_TZE204_ztc6ggyl']),
        ],
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_whkgqxse'}],
        model: 'JM-TRH-ZGB-V1',
        vendor: 'TuYa',
        description: 'Temperature & humidity sensor with clock',
        fromZigbee: [fz.nous_lcd_temperature_humidity_sensor, fz.ignore_tuya_set_time],
        toZigbee: [tz.nous_lcd_temperature_humidity_sensor],
        onEvent: tuya.onEventSetLocalTime,
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genBasic']);
        },
        exposes: [
            e.temperature(), e.humidity(), e.battery(),
            exposes.numeric('temperature_report_interval', ea.STATE_SET).withUnit('min').withValueMin(5).withValueMax(60).withValueStep(5)
                .withDescription('Temperature Report interval'),
            exposes.enum('temperature_unit_convert', ea.STATE_SET, ['celsius', 'fahrenheit']).withDescription('Current display unit'),
            exposes.enum('temperature_alarm', ea.STATE, ['canceled', 'lower_alarm', 'upper_alarm'])
                .withDescription('Temperature alarm status'),
            exposes.numeric('max_temperature', ea.STATE_SET).withUnit('°C').withValueMin(-20).withValueMax(60)
                .withDescription('Alarm temperature max'),
            exposes.numeric('min_temperature', ea.STATE_SET).withUnit('°C').withValueMin(-20).withValueMax(60)
                .withDescription('Alarm temperature min'),
            exposes.enum('humidity_alarm', ea.STATE, ['canceled', 'lower_alarm', 'upper_alarm'])
                .withDescription('Humidity alarm status'),
            exposes.numeric('max_humidity', ea.STATE_SET).withUnit('%').withValueMin(0).withValueMax(100)
                .withDescription('Alarm humidity max'),
            exposes.numeric('min_humidity', ea.STATE_SET).withUnit('%').withValueMin(0).withValueMax(100)
                .withDescription('Alarm humidity min'),
        ],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_3towulqd', '_TZE200_1ibpyhdc', '_TZE200_bh3n6gk8']),
        model: 'ZG-204ZL',
        vendor: 'TuYa',
        description: 'Luminance motion sensor',
        fromZigbee: [fz.ZG204ZL_lms],
        toZigbee: [tz.ZG204ZL_lms],
        exposes: [
            e.occupancy(), e.illuminance().withUnit('lx'), e.battery(),
            exposes.enum('sensitivity', ea.ALL, ['low', 'medium', 'high'])
                .withDescription('PIR sensor sensitivity (refresh and update only while active)'),
            exposes.enum('keep_time', ea.ALL, ['10', '30', '60', '120'])
                .withDescription('PIR keep time in seconds (refresh and update only while active)'),
        ],
    },
    {
        fingerprint: [{modelID: 'TS004F', manufacturerName: '_TZ3000_kjfzuycl'},
            {modelID: 'TS004F', manufacturerName: '_TZ3000_ja5osu5g'}],
        model: 'ERS-10TZBVB-AA',
        vendor: 'TuYa',
        description: 'Smart button',
        fromZigbee: [
            fz.command_step, fz.command_on, fz.command_off, fz.command_move_to_color_temp, fz.command_move_to_level,
            fz.tuya_multi_action, fz.tuya_operation_mode, fz.battery,
        ],
        toZigbee: [tz.tuya_operation_mode],
        exposes: [
            e.action([
                'single', 'double', 'hold', 'brightness_move_to_level', 'color_temperature_move',
                'brightness_step_up', 'brightness_step_down', 'on', 'off',
            ]),
            e.battery(),
            exposes.enum('operation_mode', ea.ALL, ['command', 'event']).withDescription(
                'Operation mode: "command" - for group control, "event" - for clicks'),
        ],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await endpoint.read('genBasic', [0x0004, 0x000, 0x0001, 0x0005, 0x0007, 0xfffe]);
            await endpoint.write('genOnOff', {'tuyaOperationMode': 1});
            await endpoint.read('genOnOff', ['tuyaOperationMode']);
            try {
                await endpoint.read(0xE001, [0xD011]);
            } catch (err) {/* do nothing */}
            await endpoint.read('genPowerCfg', ['batteryVoltage', 'batteryPercentageRemaining']);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg']);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff']);
            await reporting.batteryPercentageRemaining(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_zyrdrmno'}],
        model: 'ZB-Sm',
        vendor: 'TuYa',
        description: 'Tubular motor',
        fromZigbee: [fzLocal.zb_sm_cover, fz.ignore_basic_report],
        toZigbee: [tzLocal.zb_sm_cover],
        onEvent: tuya.onEventSetTime,
        exposes: [
            e.cover_position().setAccess('position', ea.STATE_SET),
            exposes.enum('goto_positon', ea.SET, ['25', '50', '75', 'FAVORITE']),
            exposes.enum('motor_state', ea.STATE, ['OPENING', 'CLOSING', 'STOPPED']),
            exposes.numeric('active_power', ea.STATE).withDescription('Active power').withUnit('mWt'),
            exposes.numeric('cycle_count', ea.STATE).withDescription('Cycle count'),
            exposes.numeric('cycle_time', ea.STATE).withDescription('Cycle time').withUnit('ms'),
            exposes.enum('top_limit', ea.STATE_SET, ['SET', 'CLEAR']).withDescription('Setup or clear top limit'),
            exposes.enum('bottom_limit', ea.STATE_SET, ['SET', 'CLEAR']).withDescription('Setup or clear bottom limit'),
            exposes.numeric('favorite_position', ea.STATE_SET).withValueMin(0).withValueMax(100)
                .withDescription('Favorite position of this cover'),
            exposes.binary(`reverse_direction`, ea.STATE_SET, true, false).withDescription(`Inverts the cover direction`),
            exposes.text('motor_type', ea.STATE),
            exposes.enum('report', ea.SET, ['']),
        ],
    },
    {
        fingerprint: [{modelID: 'TS1201', manufacturerName: '_TZ3290_7v1k4vufotpowp9z'}],
        model: 'ZS06',
        vendor: 'TuYa',
        description: 'Universal smart IR remote control',
        fromZigbee: [
            fzZosung.zosung_send_ir_code_00, fzZosung.zosung_send_ir_code_01, fzZosung.zosung_send_ir_code_02,
            fzZosung.zosung_send_ir_code_03, fzZosung.zosung_send_ir_code_04, fzZosung.zosung_send_ir_code_05,
        ],
        toZigbee: [tzZosung.zosung_ir_code_to_send, tzZosung.zosung_learn_ir_code],
        exposes: [ez.learn_ir_code(), ez.learned_ir_code(), ez.ir_code_to_send()],
    },
    {
        fingerprint: [{modelID: 'TS0201', manufacturerName: '_TZ3000_itnrsufe'}],
        model: 'KCTW1Z',
        vendor: 'TuYa',
        description: 'Temperature & humidity sensor with LCD',
        fromZigbee: [fz.temperature, fzLocal.humidity10, fzLocal.temperature_unit, fz.battery, fz.ignore_tuya_set_time],
        toZigbee: [tzLocal.temperature_unit],
        onEvent: tuya.onEventSetLocalTime,
        exposes: [
            e.temperature(), e.humidity(), e.battery(), e.battery_voltage(),
            exposes.enum('temperature_unit', ea.STATE_SET, ['celsius', 'fahrenheit']).withDescription('Current display unit'),
        ],
        configure: async (device, coordinatorEndpoint, logger) => {
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genPowerCfg', 'msTemperatureMeasurement', 'msRelativeHumidity']);
            await endpoint.read('genPowerCfg', ['batteryVoltage', 'batteryPercentageRemaining']);
            await reporting.batteryPercentageRemaining(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS0601', manufacturerName: '_TZE200_0u3bj3rc'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_v6ossqfy'},
            {modelID: 'TS0601', manufacturerName: '_TZE200_mx6u6l4y'}],
        model: 'TS0601_human_presence_sensor',
        vendor: 'TuYa',
        description: 'Human presence sensor Zigbee',
        fromZigbee: [fzLocal.hpsz],
        toZigbee: [tzLocal.hpsz],
        onEvent: tuya.onEventSetLocalTime,
        exposes: [e.presence(),
            exposes.numeric('duration_of_attendance', ea.STATE).withUnit('min')
                .withDescription('Shows the presence duration in minutes'),
            exposes.numeric('duration_of_absence', ea.STATE).withUnit('min')
                .withDescription('Shows the duration of the absence in minutes'),
            exposes.binary('led_state', ea.STATE_SET, true, false)
                .withDescription('Turns the onboard LED on or off'),
        ],
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_qoy0ekbd', '_TZE200_znbl8dj5', '_TZE200_a8sdabtg']),
        model: 'ZG-227ZL',
        vendor: 'TuYa',
        description: 'Temperature & humidity LCD sensor',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [e.temperature(), e.humidity(), tuya.exposes.temperatureUnit(), tuya.exposes.temperatureCalibration(),
            tuya.exposes.humidityCalibration(), e.battery()],
        meta: {
            tuyaDatapoints: [
                [1, 'temperature', tuya.valueConverter.divideBy10],
                [2, 'humidity', tuya.valueConverter.raw],
                [4, 'battery', tuya.valueConverter.raw],
                [9, 'temperature_unit', tuya.valueConverter.temperatureUnit],
                [23, 'temperature_calibration', tuya.valueConverter.divideBy10],
                [24, 'humidity_calibration', tuya.valueConverter.raw],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_n8dljorx', '_TZE200_pay2byax']),
        model: 'ZG-102ZL',
        vendor: 'TuYa',
        description: 'Luminance door sensor',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [e.contact(), e.illuminance().withUnit('lx'), e.battery()],
        meta: {
            tuyaDatapoints: [
                [1, 'contact', tuya.valueConverter.inverse],
                [101, 'illuminance', tuya.valueConverter.raw],
                [2, 'battery', tuya.valueConverter.raw],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_8isdky6j']),
        model: 'ZG-225Z',
        vendor: 'TuYa',
        description: 'Gas sensor',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [e.gas(), tuya.exposes.gasValue().withUnit('ppm')],
        meta: {
            tuyaDatapoints: [
                [1, 'gas', tuya.valueConverter.trueFalse0],
                [2, 'gas_value', tuya.valueConverter.raw],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS110E', ['_TZ3210_zxbtub8r', '_TZ3210_k1msuvg6', '_TZ3210_weaqkhab']),
        model: 'TS110E_1gang_1',
        vendor: 'TuYa',
        description: '1 channel dimmer',
        fromZigbee: extend.light_onoff_brightness({disablePowerOnBehavior: true, disableMoveStep: true, disableTransition: true})
            .fromZigbee.concat([tuya.fz.power_on_behavior_1, fzLocal.TS110E_switch_type, fzLocal.TS110E]),
        toZigbee: utils.replaceInArray(
            extend.light_onoff_brightness({disablePowerOnBehavior: true, disableMoveStep: true, disableTransition: true})
                .toZigbee.concat([tuya.tz.power_on_behavior_1, tzLocal.TS110E_options]),
            [tz.light_onoff_brightness],
            [tzLocal.TS110E_light_onoff_brightness],
        ),
        exposes: (device, options) => {
            const exps = [e.light_brightness().withMinBrightness().withMaxBrightness(), e.linkquality()];
            if (!device || !device.manufacturerName === '_TZ3210_weaqkhab') {
                // _TZ3210_weaqkhab doesn't support power_on_behavior and switch_type
                exps.push(e.power_on_behavior(), tuya.exposes.switchType());
            }
            return exps;
        },
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await extend.light_onoff_brightness().configure(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff', 'genLevelCtrl']);
        },
    },
    {
        fingerprint: tuya.fingerprint('TS110E', ['_TZ3210_ngqk6jia']),
        model: 'TS110E_1gang_2',
        vendor: 'TuYa',
        description: '1 channel dimmer',
        whiteLabel: [{vendor: 'RTX', model: 'QS-Zigbee-D02-TRIAC-LN'}],
        fromZigbee: [fzLocal.TS110E, fzLocal.TS110E_light_type, tuya.fz.power_on_behavior_1, fz.on_off],
        toZigbee: [tzLocal.TS110E_onoff_brightness, tzLocal.TS110E_options, tuya.tz.power_on_behavior_1, tz.light_brightness_move],
        exposes: [
            e.light_brightness().withMinBrightness().withMaxBrightness(),
            tuya.exposes.lightType().withAccess(ea.ALL), e.power_on_behavior().withAccess(ea.ALL)],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'genLevelCtrl']);
            await reporting.onOff(endpoint);
        },
    },
    {
        fingerprint: [{modelID: 'TS110E', manufacturerName: '_TZ3210_wdexaypg'}, {modelID: 'TS110E', manufacturerName: '_TZ3210_3mpwqzuu'}],
        model: 'TS110E_2gang_1',
        vendor: 'TuYa',
        description: '2 channel dimmer',
        fromZigbee: extend.light_onoff_brightness({disablePowerOnBehavior: true, disableMoveStep: true, disableTransition: true})
            .fromZigbee.concat([tuya.fz.power_on_behavior_1, fzLocal.TS110E_switch_type, fzLocal.TS110E]),
        toZigbee: utils.replaceInArray(
            extend.light_onoff_brightness({disablePowerOnBehavior: true, disableMoveStep: true, disableTransition: true})
                .toZigbee.concat([tuya.tz.power_on_behavior_1, tzLocal.TS110E_options]),
            [tz.light_onoff_brightness],
            [tzLocal.TS110E_light_onoff_brightness],
        ),
        meta: {multiEndpoint: true},
        exposes: [
            e.light_brightness().withMinBrightness().withMaxBrightness().withEndpoint('l1'),
            e.light_brightness().withMinBrightness().withMaxBrightness().withEndpoint('l2'),
            e.power_on_behavior(),
            tuya.exposes.switchType().withEndpoint('l1'),
            tuya.exposes.switchType().withEndpoint('l2'),
        ],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            await extend.light_onoff_brightness().configure(device, coordinatorEndpoint, logger);
            await reporting.bind(device.getEndpoint(1), coordinatorEndpoint, ['genOnOff', 'genLevelCtrl']);
            await reporting.bind(device.getEndpoint(2), coordinatorEndpoint, ['genOnOff', 'genLevelCtrl']);
        },
        endpoint: (device) => {
            return {l1: 1, l2: 2};
        },
    },
    {
        fingerprint: tuya.fingerprint('TS110E', ['_TZ3210_pagajpog', '_TZ3210_4ubylghk']),
        model: 'TS110E_2gang_2',
        vendor: 'TuYa',
        description: '2 channel dimmer',
        fromZigbee: [fzLocal.TS110E, fzLocal.TS110E_light_type, tuya.fz.power_on_behavior_1, fz.on_off],
        toZigbee: [tzLocal.TS110E_onoff_brightness, tzLocal.TS110E_options, tuya.tz.power_on_behavior_1, tz.light_brightness_move],
        meta: {multiEndpoint: true},
        exposes: [
            e.light_brightness().withMinBrightness().withMaxBrightness().withEndpoint('l1'),
            e.light_brightness().withMinBrightness().withMaxBrightness().withEndpoint('l2'),
            e.power_on_behavior().withAccess(ea.ALL)],
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'genLevelCtrl']);
            await reporting.onOff(endpoint);
        },
        endpoint: (device) => {
            return {l1: 1, l2: 2};
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_nslr42tt']),
        model: 'TS0601_3_phase_clamp_meter',
        vendor: 'TuYa',
        description: '3-phase clamp power meter',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        whiteLabel: [{vendor: 'MatSeePlus', model: 'PC321-Z-TY'}],
        exposes: [
            e.ac_frequency(), e.temperature(), e.current(), e.power(), e.energy(),
            tuya.exposes.energyWithPhase('a'), tuya.exposes.energyWithPhase('b'), tuya.exposes.energyWithPhase('c'),
            tuya.exposes.voltageWithPhase('a'), tuya.exposes.voltageWithPhase('b'), tuya.exposes.voltageWithPhase('c'),
            tuya.exposes.powerWithPhase('a'), tuya.exposes.powerWithPhase('b'), tuya.exposes.powerWithPhase('c'),
            tuya.exposes.currentWithPhase('a'), tuya.exposes.currentWithPhase('b'), tuya.exposes.currentWithPhase('c'),
            tuya.exposes.powerFactorWithPhase('a'), tuya.exposes.powerFactorWithPhase('b'), tuya.exposes.powerFactorWithPhase('c'),
        ],
        meta: {
            tuyaDatapoints: [
                [132, 'ac_frequency', tuya.valueConverter.raw],
                [133, 'temperature', tuya.valueConverter.divideBy10],
                [1, 'energy', tuya.valueConverter.divideBy100],
                [101, 'energy_a', tuya.valueConverter.divideBy1000],
                [111, 'energy_b', tuya.valueConverter.divideBy1000],
                [121, 'energy_c', tuya.valueConverter.divideBy1000],
                [131, 'current', tuya.valueConverter.divideBy1000],
                [9, 'power', tuya.valueConverter.raw],
                [102, 'power_factor_a', tuya.valueConverter.raw],
                [112, 'power_factor_b', tuya.valueConverter.raw],
                [122, 'power_factor_c', tuya.valueConverter.raw],
                [6, null, tuya.valueConverter.phaseVariant2WithPhase('a')],
                [7, null, tuya.valueConverter.phaseVariant2WithPhase('b')],
                [8, null, tuya.valueConverter.phaseVariant2WithPhase('c')],
                [134, 'device_status', tuya.valueConverter.raw],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_x8fp01wi']),
        model: 'TS0601_3_phase_clamp_meter_relay',
        vendor: 'TuYa',
        description: '3-phase clamp power meter with relay',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        whiteLabel: [{vendor: 'Wenzhou Taiye Electric', model: 'TAC7361C BI'}],
        exposes: [
            e.switch().setAccess('state', ea.STATE_SET), e.power(), e.energy(), e.produced_energy(),
            tuya.exposes.voltageWithPhase('a'), tuya.exposes.voltageWithPhase('b'), tuya.exposes.voltageWithPhase('c'),
            tuya.exposes.powerWithPhase('a'), tuya.exposes.powerWithPhase('b'), tuya.exposes.powerWithPhase('c'),
            tuya.exposes.currentWithPhase('a'), tuya.exposes.currentWithPhase('b'), tuya.exposes.currentWithPhase('c'),
        ],
        meta: {
            tuyaDatapoints: [
                [16, 'state', tuya.valueConverter.onOff],
                [1, 'energy', tuya.valueConverter.divideBy100],
                [2, 'produced_energy', tuya.valueConverter.divideBy100],
                [9, 'power', tuya.valueConverter.raw],
                [6, null, tuya.valueConverter.phaseVariant2WithPhase('a')],
                [7, null, tuya.valueConverter.phaseVariant2WithPhase('b')],
                [8, null, tuya.valueConverter.phaseVariant2WithPhase('c')],
            ],
        },
    },
    {
        zigbeeModel: ['TS0049'],
        model: 'TS0049',
        vendor: 'TuYa',
        description: 'Water valve',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        onEvent: tuya.onEventSetLocalTime,
        configure: tuya.configureMagicPacket,
        exposes: [tuya.exposes.errorStatus(), tuya.exposes.switch(), tuya.exposes.batteryState(),
            tuya.exposes.countdown().withValueMin(0).withValueMax(255).withUnit('minutes')
                .withDescription('Max on time in minutes'),
        ],
        meta: {
            tuyaSendCommand: 'sendData',
            tuyaDatapoints: [
                [26, 'error_status', tuya.valueConverter.raw],
                [101, 'state', tuya.valueConverter.onOff],
                [111, 'countdown', tuya.valueConverter.raw],
                [115, 'battery_state', tuya.valueConverter.batteryState],
            ],
        },
    },
    {
        fingerprint: tuya.fingerprint('TS0601', ['_TZE200_r32ctezx']),
        model: 'TS0601_fan_switch',
        vendor: 'TuYa',
        description: 'Fan switch',
        fromZigbee: [tuya.fz.datapoints],
        toZigbee: [tuya.tz.datapoints],
        configure: tuya.configureMagicPacket,
        exposes: [
            tuya.exposes.switch(), e.power_on_behavior(['off', 'on']).withAccess(ea.STATE_SET),
            tuya.exposes.countdown().withValueMin(0).withValueMax(43200).withUnit('s').withDescription('Max ON time in seconds'),
            exposes.numeric('fan_speed', ea.STATE_SET).withValueMin(1).withValueMax(5).withValueStep(1)
                .withDescription('Speed off the fan'),
        ],
        meta: {
            tuyaDatapoints: [
                [1, 'state', tuya.valueConverter.onOff],
                [2, 'countdown', tuya.valueConverter.countdown],
                [3, 'fan_speed', tuya.valueConverterBasic
                    .lookup({'1': tuya.enum(0), '2': tuya.enum(1), '3': tuya.enum(2), '4': tuya.enum(3), '5': tuya.enum(4)})],
                [11, 'power_on_behavior', tuya.valueConverterBasic.lookup({'off': tuya.enum(0), 'on': tuya.enum(1)})],
            ],
        },
        whiteLabel: [
            {vendor: 'Lerlink', model: 'T2-Z67/T2-W67'},
        ],
    },
    {
        zigbeeModel: ['TS0224'],
        model: 'TS0224',
        vendor: 'TuYa',
        description: 'Smart light & sound siren',
        fromZigbee: [],
        toZigbee: [tz.warning, tzLocal.TS0224],
        exposes: [e.warning(),
            exposes.binary('light', ea.STATE_SET, 'ON', 'OFF').withDescription('Turn the light of the alarm ON/OFF'),
            exposes.numeric('duration', ea.STATE_SET).withValueMin(60).withValueMax(3600).withValueStep(1).withUnit('s')
                .withDescription('Duration of the alarm'),
            exposes.enum('volume', ea.STATE_SET, ['mute', 'low', 'medium', 'high'])
                .withDescription('Volume of the alarm'),
        ],
    },
    {
        fingerprint: tuya.fingerprint('TS0041', ['_TZ3000_fa9mlvja']),
        model: 'IH-K663',
        vendor: 'TuYa',
        description: 'Smart button',
        exposes: [e.battery(), e.battery_voltage(), e.action(['single', 'double'])],
        fromZigbee: [fz.tuya_on_off_action, fz.battery],
        toZigbee: [],
        configure: tuya.configureMagicPacket,
    },
    {
        fingerprint: tuya.fingerprint('TS011F', ['_TZ3000_cayepv1a']),
        model: 'TS011F_with_threshold',
        description: 'Din rail switch with power monitoring and threshold settings',
        vendor: 'TuYa',
        ota: ota.zigbeeOTA,
        extend: tuya.extend.switch({
            electricalMeasurements: true, electricalMeasurementsFzConverter: fzLocal.TS011F_electrical_measurement,
            powerOutageMemory: true, indicatorMode: true,
            fromZigbee: [fz.temperature, fzLocal.TS011F_threshold],
            toZigbee: [tzLocal.TS011F_threshold],
            exposes: [
                e.temperature(),
                exposes.numeric('temperature_threshold', ea.STATE_SET).withValueMin(40).withValueMax(100).withValueStep(1).withUnit('*C')
                    .withDescription('High temperature threshold'),
                exposes.binary('temperature_breaker', ea.STATE_SET, 'ON', 'OFF')
                    .withDescription('High temperature breaker'),
                exposes.numeric('power_threshold', ea.STATE_SET).withValueMin(1).withValueMax(26).withValueStep(1).withUnit('kW')
                    .withDescription('High power threshold'),
                exposes.binary('power_breaker', ea.STATE_SET, 'ON', 'OFF')
                    .withDescription('High power breaker'),
                exposes.numeric('over_current_threshold', ea.STATE_SET).withValueMin(1).withValueMax(64).withValueStep(1).withUnit('A')
                    .withDescription('Over-current threshold'),
                exposes.binary('over_current_breaker', ea.STATE_SET, 'ON', 'OFF')
                    .withDescription('Over-current breaker'),
                exposes.numeric('over_voltage_threshold', ea.STATE_SET).withValueMin(220).withValueMax(260).withValueStep(1).withUnit('V')
                    .withDescription('Over-voltage threshold'),
                exposes.binary('over_voltage_breaker', ea.STATE_SET, 'ON', 'OFF')
                    .withDescription('Over-voltage breaker'),
                exposes.numeric('under_voltage_threshold', ea.STATE_SET).withValueMin(76).withValueMax(240).withValueStep(1).withUnit('V')
                    .withDescription('Under-voltage threshold'),
                exposes.binary('under_voltage_breaker', ea.STATE_SET, 'ON', 'OFF')
                    .withDescription('Under-voltage breaker'),
            ],
        }),
        configure: async (device, coordinatorEndpoint, logger) => {
            await tuya.configureMagicPacket(device, coordinatorEndpoint, logger);
            const endpoint = device.getEndpoint(1);
            endpoint.command('genBasic', 'tuyaSetup', {});
            await reporting.bind(endpoint, coordinatorEndpoint, ['msTemperatureMeasurement']);
            await reporting.bind(endpoint, coordinatorEndpoint, ['genOnOff', 'haElectricalMeasurement', 'seMetering']);
            await reporting.rmsVoltage(endpoint, {change: 5});
            await reporting.rmsCurrent(endpoint, {change: 50});
            await reporting.activePower(endpoint, {change: 10});
            await reporting.currentSummDelivered(endpoint);
            endpoint.saveClusterAttributeKeyValue('haElectricalMeasurement', {acCurrentDivisor: 1000, acCurrentMultiplier: 1});
            endpoint.saveClusterAttributeKeyValue('seMetering', {divisor: 100, multiplier: 1});
            device.save();
        },
        whiteLabel: [
            tuya.whitelabel('TONGOU', 'TO-Q-SY2-163JZT', 'Smart circuit breaker', ['_TZ3000_cayepv1a']),
        ],
    },
];
