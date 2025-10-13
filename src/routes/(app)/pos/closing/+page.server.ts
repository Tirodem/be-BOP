import {
	closePosSession,
	getCurrentPosSession,
	calculateDailyIncomes
} from '$lib/server/pos-sessions';
import { runtimeConfig } from '$lib/server/runtime-config';
import { error, redirect } from '@sveltejs/kit';
import { ObjectId } from 'mongodb';
import type { Currency } from '$lib/types/Currency';
import type { Actions } from './$types';

export const load = async ({ locals }: { locals: App.Locals }) => {
	const posSession = await getCurrentPosSession();

	if (!posSession) {
		throw error(404, 'No active POS session');
	}

	const incomesMap = await calculateDailyIncomes(posSession);

	return {
		session: {
			_id: posSession._id.toString(),
			openedAt: posSession.openedAt,
			cashOpening: posSession.cashOpening
		},
		incomes: Array.from(incomesMap.entries()).map(([method, data]) => ({
			method,
			amount: data.amount,
			currency: data.currency
		})),
		cashDeltaJustificationMandatory: runtimeConfig.posCashDeltaJustificationMandatory,
		user: locals.user
			? {
					alias: locals.user.alias,
					login: locals.user.login
			  }
			: null
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) {
			throw error(401, 'Unauthorized');
		}

		const formData = await request.formData();
		const sessionId = new ObjectId(String(formData.get('sessionId')));
		const cashClosingAmount = Number(formData.get('cashClosingAmount'));
		const bankDepositAmount = Number(formData.get('bankDepositAmount'));
		const justification = String(formData.get('justification') ?? '');
		const currency = String(formData.get('currency'));

		if (isNaN(cashClosingAmount) || cashClosingAmount < 0) {
			throw error(400, 'Invalid cash closing amount');
		}

		if (isNaN(bankDepositAmount) || bankDepositAmount < 0) {
			throw error(400, 'Invalid bank deposit amount');
		}

		await closePosSession({
			sessionId,
			cashClosing: {
				amount: cashClosingAmount,
				currency: currency as Currency
			},
			outcomes: [
				{
					category: 'bank-deposit',
					amount: bankDepositAmount,
					currency: currency as Currency
				}
			],
			cashDeltaJustification: justification || undefined,
			user: {
				userId: locals.user._id,
				userLogin: locals.user.login,
				userAlias: locals.user.alias
			}
		});

		throw redirect(303, `/pos/history/${sessionId.toString()}/z-ticket?justClosed=true`);
	}
};
