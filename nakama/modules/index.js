const SAVE_VERSION = 3;
const STATE_COLLECTION = "player_state";
const STATE_KEY = "state";
const PURCHASE_COLLECTION = "purchase_log";

const COIN_PACKS = {
	"coins_small": 1000,
	"coins_medium": 5000,
	"coins_large": 12000,
	"coins_ultra": 30000
};

function InitModule(ctx, logger, nk, initializer) {
	initializer.registerRpc("scrollsort.bootstrap", rpcBootstrap);
	initializer.registerRpc("scrollsort.sync_state", rpcSyncState);
	initializer.registerRpc("scrollsort.submit_run", rpcSubmitRun);
	initializer.registerRpc("scrollsort.validate_purchase", rpcValidatePurchase);
	logger.info("scrollsort module loaded");
}

function rpcBootstrap(ctx, logger, nk, payload) {
	var env = ctx.env ? ctx.env : {};
	var now = Math.floor(Date.now() / 1000);
	var response = {
		"server_time": now,
		"catalog_url": env.STAGE_CATALOG_URL || "https://your-cdn.com/puzzle/stages_v1.json",
		"catalog_version": env.STAGE_CATALOG_VERSION || "v1",
		"features": {
			"leaderboards": env.ENABLE_LEADERBOARDS === "true",
			"daily_challenge": env.ENABLE_DAILY_CHALLENGE === "true"
		}
	};
	return JSON.stringify(response);
}

function rpcSyncState(ctx, logger, nk, payload) {
	var data = parsePayload(payload);
	var incoming = data.state ? data.state : {};
	var stored = readState(ctx, nk);
	var state;
	if (stored == null) {
		state = sanitizeState(incoming);
	} else {
		state = mergeStates(stored, incoming);
	}
	state.rev = intValue(state.rev, 0) + 1;
	state.updated_at = Math.floor(Date.now() / 1000);
	writeState(ctx, nk, state);
	return JSON.stringify({
		"state": state,
		"server_time": state.updated_at,
		"rev": state.rev
	});
}

function rpcSubmitRun(ctx, logger, nk, payload) {
	var data = parsePayload(payload);
	var stageId = stringValue(data.stage_id);
	if (stageId === "") {
		throw Error("stage_id required");
	}
	var moves = intValue(data.moves, -1);
	var timeSec = floatValue(data.time_sec, 0.0);
	var timeMs = intValue(data.time_ms, 0);
	var difficulty = intValue(data.difficulty, 1);
	var adsUsed = intValue(data.ads_used, 0);
	if (timeSec <= 0.0 && timeMs > 0) {
		timeSec = timeMs / 1000.0;
	}
	var stars = intValue(data.stars, 0);
	var rewardCoins = intValue(data.reward_coins, 0);

	var env = ctx.env ? ctx.env : {};
	var maxReward = intValue(env.MAX_STAGE_REWARD, 0);
	if (maxReward > 0 && rewardCoins > maxReward) {
		rewardCoins = maxReward;
	}

	var state = readState(ctx, nk);
	if (state == null) {
		state = sanitizeState({});
	} else {
		state = sanitizeState(state);
	}

	if (rewardCoins > 0) {
		state.coins = intValue(state.coins, 0) + rewardCoins;
	}

	state.stats = state.stats || {};
	state.stats.best_scores = state.stats.best_scores || {};
	var best = state.stats.best_scores[stageId];
	if (!best) {
		best = {"moves": -1, "time": 0.0, "ads_used": 0};
	}
	if (moves >= 0 && (best.moves < 0 || moves < best.moves)) {
		best.moves = moves;
		best.ads_used = adsUsed;
	}
	if (timeSec > 0 && (best.time <= 0 || timeSec < best.time)) {
		best.time = timeSec;
		best.ads_used = adsUsed;
	}
	if (best.moves == moves && best.time == timeSec && adsUsed < intValue(best.ads_used, 0)) {
		best.ads_used = adsUsed;
	}
	state.stats.best_scores[stageId] = best;

	if (stars > 0) {
		state.stats.stage_stars = state.stats.stage_stars || {};
		var prevStars = intValue(state.stats.stage_stars[stageId], 0);
		state.stats.stage_stars[stageId] = Math.max(prevStars, stars);
	}

	state.progress = state.progress || {};
	state.progress.completed_stage_ids = arrayStringUnion(
		state.progress.completed_stage_ids || [],
		[stageId]
	);
	state.progress.stage_difficulty_completed = state.progress.stage_difficulty_completed || {};
	var prevDifficulty = intValue(state.progress.stage_difficulty_completed[stageId], 0);
	state.progress.stage_difficulty_completed[stageId] = Math.max(prevDifficulty, difficulty);
	state.progress.stage_difficulty_unlocked = state.progress.stage_difficulty_unlocked || {};
	var nextDifficulty = difficulty + 1;
	if (nextDifficulty < 1) {
		nextDifficulty = 1;
	} else if (nextDifficulty > 3) {
		nextDifficulty = 3;
	}
	var prevUnlocked = intValue(state.progress.stage_difficulty_unlocked[stageId], 1);
	state.progress.stage_difficulty_unlocked[stageId] = Math.max(prevUnlocked, nextDifficulty);

	updateDailyState(state, stageId, Math.floor(Date.now() / 1000));

	state.rev = intValue(state.rev, 0) + 1;
	state.updated_at = Math.floor(Date.now() / 1000);
	writeState(ctx, nk, state);

	return JSON.stringify({
		"state": state,
		"server_time": state.updated_at,
		"rev": state.rev
	});
}

function rpcValidatePurchase(ctx, logger, nk, payload) {
	var data = parsePayload(payload);
	var productId = stringValue(data.product_id);
	var provider = stringValue(data.provider);
	var mock = boolValue(data.mock, false);
	var purchaseId = stringValue(data.purchase_id);
	if (purchaseId === "") {
		purchaseId = stringValue(data.transaction_id);
	}
	if (purchaseId === "") {
		purchaseId = stringValue(data.order_id);
	}
	if (purchaseId === "") {
		throw Error("purchase_id required");
	}

	var env = ctx.env ? ctx.env : {};
	if (!mock && env.ALLOW_MOCK_PURCHASES === "true") {
		mock = true;
	}

	if (!mock) {
		validateReceipt(provider, data, nk);
	}

	if (isPurchaseApplied(ctx, nk, purchaseId)) {
		var existingState = readState(ctx, nk) || sanitizeState({});
		return JSON.stringify({"state": existingState, "already_applied": true});
	}

	var state = readState(ctx, nk);
	if (state == null) {
		state = sanitizeState({});
	} else {
		state = sanitizeState(state);
	}

	if (COIN_PACKS.hasOwnProperty(productId)) {
		state.coins = intValue(state.coins, 0) + COIN_PACKS[productId];
	} else if (productId == "remove_ads") {
		state.shop.remove_ads = true;
	} else if (productId !== "") {
		state.shop.entitlements[productId] = true;
	}

	state.rev = intValue(state.rev, 0) + 1;
	state.updated_at = Math.floor(Date.now() / 1000);
	writeState(ctx, nk, state);
	markPurchaseApplied(ctx, nk, purchaseId, productId, provider);

	return JSON.stringify({
		"state": state,
		"purchase_id": purchaseId
	});
}

function validateReceipt(provider, data, nk) {
	var receipt = stringValue(data.receipt);
	if (provider === "google") {
		var signature = stringValue(data.signature);
		return nk.purchaseValidateGoogle(receipt, signature, true);
	}
	if (provider === "apple") {
		return nk.purchaseValidateApple(receipt, true);
	}
	if (provider === "huawei") {
		var huaweiSignature = stringValue(data.signature);
		return nk.purchaseValidateHuawei(receipt, huaweiSignature, true);
	}
	throw Error("unsupported provider");
}

function readState(ctx, nk) {
	var objects = nk.storageRead([{
		"collection": STATE_COLLECTION,
		"key": STATE_KEY,
		"userId": ctx.userId
	}]);
	if (!objects || objects.length === 0) {
		return null;
	}
	var value = objects[0].value;
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch (_err) {
			return null;
		}
	}
	return value;
}

function writeState(ctx, nk, state) {
	nk.storageWrite([{
		"collection": STATE_COLLECTION,
		"key": STATE_KEY,
		"userId": ctx.userId,
		"value": state,
		"permissionRead": 0,
		"permissionWrite": 0
	}]);
}

function isPurchaseApplied(ctx, nk, purchaseId) {
	var objects = nk.storageRead([{
		"collection": PURCHASE_COLLECTION,
		"key": purchaseId,
		"userId": ctx.userId
	}]);
	return objects && objects.length > 0;
}

function markPurchaseApplied(ctx, nk, purchaseId, productId, provider) {
	nk.storageWrite([{
		"collection": PURCHASE_COLLECTION,
		"key": purchaseId,
		"userId": ctx.userId,
		"value": {
			"product_id": productId,
			"provider": provider,
			"timestamp": Math.floor(Date.now() / 1000)
		},
		"permissionRead": 0,
		"permissionWrite": 0
	}]);
}

function sanitizeState(state) {
	state = state || {};
	var shop = state.shop || {};
	var unlocks = state.unlocks || {};
	var progress = state.progress || {};
	var meta = state.meta || {};
	var daily = state.daily || {};
	var stats = state.stats || {};
	return {
		"save_version": SAVE_VERSION,
		"coins": intValue(state.coins, 0),
		"shop": {
			"hints": intValue(shop.hints, 0),
			"remove_ads": boolValue(shop.remove_ads, false),
			"entitlements": sanitizeBoolDict(shop.entitlements)
		},
		"unlocks": {
			"permanent_stage_ids": sanitizeStringArray(unlocks.permanent_stage_ids),
			"temp_stage_ids_by_date": sanitizeStringArrayDict(unlocks.temp_stage_ids_by_date)
		},
		"progress": {
			"completed_stage_ids": sanitizeStringArray(progress.completed_stage_ids),
			"stage_difficulty_completed": sanitizeIntDict(progress.stage_difficulty_completed),
			"stage_difficulty_unlocked": sanitizeIntDict(progress.stage_difficulty_unlocked)
		},
		"meta": {
			"current_stage_id": stringValue(meta.current_stage_id),
			"current_stage_is_dlc": boolValue(meta.current_stage_is_dlc, false),
			"current_main_level_index": intValue(meta.current_main_level_index, 1),
			"current_dlc_pack_id": stringValue(meta.current_dlc_pack_id),
			"current_dlc_level_index": intValue(meta.current_dlc_level_index, 1),
			"highest_main_unlocked_index": intValue(meta.highest_main_unlocked_index, 1),
			"current_stage_difficulty": intValue(meta.current_stage_difficulty, 1)
		},
		"daily": {
			"daily_completion_log": sanitizeDailyLog(daily.daily_completion_log),
			"daily_streak": intValue(daily.daily_streak, 0),
			"last_completion_day": intValue(daily.last_completion_day, -1)
		},
		"stats": {
			"best_scores": sanitizeBestScores(stats.best_scores),
			"stage_stars": sanitizeStageStars(stats.stage_stars)
		},
		"rev": intValue(state.rev, 0),
		"updated_at": intValue(state.updated_at, 0)
	};
}

function mergeStates(stored, incoming) {
	var base = sanitizeState(stored);
	var inc = sanitizeState(incoming);
	base.unlocks.permanent_stage_ids = arrayStringUnion(
		base.unlocks.permanent_stage_ids,
		inc.unlocks.permanent_stage_ids
	);
	base.unlocks.temp_stage_ids_by_date = mergeStringArrayDict(
		base.unlocks.temp_stage_ids_by_date,
		inc.unlocks.temp_stage_ids_by_date
	);
	base.progress.completed_stage_ids = arrayStringUnion(
		base.progress.completed_stage_ids,
		inc.progress.completed_stage_ids
	);
	base.progress.stage_difficulty_completed = mergeIntDictMax(
		base.progress.stage_difficulty_completed,
		inc.progress.stage_difficulty_completed
	);
	base.progress.stage_difficulty_unlocked = mergeIntDictMax(
		base.progress.stage_difficulty_unlocked,
		inc.progress.stage_difficulty_unlocked
	);
	base.stats.best_scores = mergeBestScores(base.stats.best_scores, inc.stats.best_scores);
	base.stats.stage_stars = mergeStageStars(base.stats.stage_stars, inc.stats.stage_stars);
	base.meta.highest_main_unlocked_index = Math.max(
		base.meta.highest_main_unlocked_index,
		inc.meta.highest_main_unlocked_index
	);
	if (base.meta.current_stage_id === "" && inc.meta.current_stage_id !== "") {
		base.meta.current_stage_id = inc.meta.current_stage_id;
		base.meta.current_stage_is_dlc = inc.meta.current_stage_is_dlc;
		base.meta.current_main_level_index = inc.meta.current_main_level_index;
		base.meta.current_dlc_pack_id = inc.meta.current_dlc_pack_id;
		base.meta.current_dlc_level_index = inc.meta.current_dlc_level_index;
	}
	if (base.daily.daily_completion_log.length === 0 && inc.daily.daily_completion_log.length > 0) {
		base.daily = inc.daily;
	}
	return base;
}

function updateDailyState(state, stageId, nowSec) {
	state.daily = state.daily || {};
	state.daily.daily_completion_log = state.daily.daily_completion_log || [];
	state.daily.daily_streak = intValue(state.daily.daily_streak, 0);
	state.daily.last_completion_day = intValue(state.daily.last_completion_day, -1);

	var todayBucket = Math.floor(nowSec / 86400);
	var todayDate = new Date(nowSec * 1000).toISOString().slice(0, 10);

	if (state.daily.last_completion_day === todayBucket) {
		// same day
	} else if (state.daily.last_completion_day === todayBucket - 1) {
		state.daily.daily_streak += 1;
	} else {
		state.daily.daily_streak = 1;
	}
	state.daily.last_completion_day = todayBucket;

	var log = state.daily.daily_completion_log;
	if (log.length === 0 || log[log.length - 1].date !== todayDate) {
		log.push({"date": todayDate, "count": 0, "stages": []});
	}
	var entry = log[log.length - 1];
	entry.count = intValue(entry.count, 0) + 1;
	entry.stages = sanitizeStringArray(entry.stages);
	entry.stages.push(stageId);
	log[log.length - 1] = entry;

	if (log.length > 60) {
		state.daily.daily_completion_log = log.slice(log.length - 60);
	}
}

function parsePayload(payload) {
	if (!payload) {
		return {};
	}
	if (typeof payload === "string") {
		try {
			return JSON.parse(payload);
		} catch (_err) {
			return {};
		}
	}
	return payload;
}

function sanitizeStringArray(arr) {
	if (!Array.isArray(arr)) {
		return [];
	}
	var out = [];
	for (var i = 0; i < arr.length; i++) {
		if (typeof arr[i] === "string") {
			out.push(arr[i]);
		}
	}
	return out;
}

function sanitizeStringArrayDict(value) {
	if (value == null || typeof value !== "object") {
		return {};
	}
	var out = {};
	for (var key in value) {
		if (typeof key !== "string") {
			continue;
		}
		out[key] = sanitizeStringArray(value[key]);
	}
	return out;
}

function sanitizeBoolDict(value) {
	if (value == null || typeof value !== "object") {
		return {};
	}
	var out = {};
	for (var key in value) {
		out[key] = !!value[key];
	}
	return out;
}

function sanitizeIntDict(value) {
	if (value == null || typeof value !== "object") {
		return {};
	}
	var out = {};
	for (var key in value) {
		out[key] = intValue(value[key], 0);
	}
	return out;
}

function sanitizeBestScores(value) {
	if (value == null || typeof value !== "object") {
		return {};
	}
	var out = {};
	for (var key in value) {
		var entry = value[key];
		if (entry == null || typeof entry !== "object") {
			continue;
		}
		var timeValue = floatValue(entry.time, -1.0);
		if (timeValue < 0) {
			var legacyMs = intValue(entry.time_ms, 0);
			timeValue = legacyMs > 0 ? legacyMs / 1000.0 : 0.0;
		}
		out[key] = {
			"moves": intValue(entry.moves, -1),
			"time": timeValue,
			"ads_used": intValue(entry.ads_used, intValue(entry.ads, 0))
		};
	}
	return out;
}

function sanitizeStageStars(value) {
	if (value == null || typeof value !== "object") {
		return {};
	}
	var out = {};
	for (var key in value) {
		out[key] = intValue(value[key], 0);
	}
	return out;
}

function sanitizeDailyLog(value) {
	if (!Array.isArray(value)) {
		return [];
	}
	var out = [];
	for (var i = 0; i < value.length; i++) {
		var entry = value[i];
		if (entry == null || typeof entry !== "object") {
			continue;
		}
		out.push({
			"date": stringValue(entry.date),
			"count": intValue(entry.count, 0),
			"stages": sanitizeStringArray(entry.stages)
		});
	}
	return out;
}

function mergeStringArrayDict(a, b) {
	var out = sanitizeStringArrayDict(a);
	var extra = sanitizeStringArrayDict(b);
	for (var key in extra) {
		out[key] = arrayStringUnion(out[key], extra[key]);
	}
	return out;
}

function mergeIntDictMax(a, b) {
	var out = sanitizeIntDict(a);
	var extra = sanitizeIntDict(b);
	for (var key in extra) {
		out[key] = Math.max(intValue(out[key], 0), intValue(extra[key], 0));
	}
	return out;
}

function arrayStringUnion(a, b) {
	var out = [];
	var seen = {};
	var first = sanitizeStringArray(a);
	var second = sanitizeStringArray(b);
	for (var i = 0; i < first.length; i++) {
		if (!seen[first[i]]) {
			seen[first[i]] = true;
			out.push(first[i]);
		}
	}
	for (var j = 0; j < second.length; j++) {
		if (!seen[second[j]]) {
			seen[second[j]] = true;
			out.push(second[j]);
		}
	}
	return out;
}

function mergeBestScores(a, b) {
	var base = sanitizeBestScores(a);
	var extra = sanitizeBestScores(b);
	for (var key in extra) {
		var incoming = extra[key];
		var current = base[key];
		if (!current) {
			base[key] = incoming;
			continue;
		}
		var incomingMoves = intValue(incoming.moves, -1);
		var currentMoves = intValue(current.moves, -1);
		var incomingTime = floatValue(incoming.time, 0.0);
		var currentTime = floatValue(current.time, 0.0);
		var incomingAds = intValue(incoming.ads_used, 0);
		var currentAds = intValue(current.ads_used, 0);

		var replace = false;
		if (incomingMoves >= 0 && (currentMoves < 0 || incomingMoves < currentMoves)) {
			replace = true;
		} else if (incomingMoves == currentMoves) {
			if (incomingTime > 0 && (currentTime <= 0 || incomingTime < currentTime)) {
				replace = true;
			} else if (incomingTime == currentTime && incomingAds < currentAds) {
				currentAds = incomingAds;
			}
		}

		if (replace) {
			current.moves = incomingMoves;
			current.time = incomingTime;
			currentAds = incomingAds;
		}
		current.ads_used = currentAds;
		base[key] = current;
	}
	return base;
}

function mergeStageStars(a, b) {
	var base = sanitizeStageStars(a);
	var extra = sanitizeStageStars(b);
	for (var key in extra) {
		base[key] = Math.max(intValue(base[key], 0), intValue(extra[key], 0));
	}
	return base;
}

function intValue(value, fallback) {
	if (fallback === undefined) {
		fallback = 0;
	}
	if (typeof value === "number") {
		return Math.floor(value);
	}
	if (typeof value === "string" && value !== "") {
		var parsed = parseInt(value, 10);
		return isNaN(parsed) ? fallback : parsed;
	}
	return fallback;
}

function floatValue(value, fallback) {
	if (fallback === undefined) {
		fallback = 0.0;
	}
	if (typeof value === "number") {
		return value;
	}
	if (typeof value === "string" && value !== "") {
		var parsed = parseFloat(value);
		return isNaN(parsed) ? fallback : parsed;
	}
	return fallback;
}

function stringValue(value) {
	if (typeof value === "string") {
		return value;
	}
	if (value === null || value === undefined) {
		return "";
	}
	return "" + value;
}

function boolValue(value, fallback) {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return value === "true";
	}
	return fallback ? true : false;
}
