import { collections } from './database';
import { runtimeConfig } from './runtime-config';
import type { PosSession, PosSessionUser } from '$lib/types/PosSession';
import { ObjectId } from 'mongodb';
import { error } from '@sveltejs/kit';
import type { PaymentMethod } from './payment-methods';
import type { Currency } from '$lib/types/Currency';

export async function getCurrentPosSession(): Promise<PosSession | null> {
	return await collections.posSessions.findOne({ status: 'active' }, { sort: { openedAt: -1 } });
}

export async function getLastClosedSession(): Promise<PosSession | null> {
	return await collections.posSessions.findOne({ status: 'closed' }, { sort: { closedAt: -1 } });
}

export async function openPosSession(params: {
	cashOpening: { amount: number; currency: Currency };
	user: PosSessionUser;
}): Promise<ObjectId> {
	if (!runtimeConfig.posSessionsEnabled) {
		throw error(400, 'POS sessions are not enabled');
	}

	const existingSession = await getCurrentPosSession();
	if (existingSession) {
		throw error(400, 'There is already an active POS session');
	}

	const lastSession = await getLastClosedSession();
	const yesterdayClosing = lastSession?.cashClosing;

	if (
		yesterdayClosing &&
		(yesterdayClosing.amount !== params.cashOpening.amount ||
			yesterdayClosing.currency !== params.cashOpening.currency)
	) {
		console.warn(
			`Opening amount mismatch! Expected: ${yesterdayClosing.amount} ${yesterdayClosing.currency}, Got: ${params.cashOpening.amount} ${params.cashOpening.currency}`
		);
	}

	const session: PosSession = {
		_id: new ObjectId(),
		status: 'active',
		openedAt: new Date(),
		openedBy: params.user,
		cashOpening: params.cashOpening,
		dailyIncomes: [],
		dailyOutcomes: [],
		xTickets: [],
		createdAt: new Date(),
		updatedAt: new Date()
	};

	await collections.posSessions.insertOne(session);
	return session._id;
}

export async function calculateDailyIncomes(
	session: PosSession
): Promise<Map<PaymentMethod, { amount: number; currency: Currency }>> {
	const orders = await collections.orders
		.find({
			createdAt: { $gte: session.openedAt },
			status: 'paid'
		})
		.toArray();

	const paidPayments = orders.flatMap((order) => order.payments).filter((p) => p.status === 'paid');

	const incomes = new Map<PaymentMethod, { amount: number; currency: Currency }>();

	paidPayments.forEach((payment) => {
		const existing = incomes.get(payment.method);
		if (existing) {
			existing.amount += payment.currencySnapshot.main.price.amount;
		} else {
			incomes.set(payment.method, {
				amount: payment.currencySnapshot.main.price.amount,
				currency: payment.currencySnapshot.main.price.currency
			});
		}
	});

	return incomes;
}

export async function closePosSession(params: {
	sessionId: ObjectId;
	cashClosing: { amount: number; currency: Currency };
	outcomes: Array<{ category: string; amount: number; currency: Currency }>;
	cashDeltaJustification?: string;
	user: PosSessionUser;
}): Promise<{ session: PosSession; zTicketText: string }> {
	const session = await collections.posSessions.findOne({ _id: params.sessionId });

	if (!session) {
		throw error(404, 'POS session not found');
	}

	if (session.status === 'closed') {
		throw error(400, 'POS session is already closed');
	}

	const incomesMap = await calculateDailyIncomes(session);
	const dailyIncomes = Array.from(incomesMap.entries()).map(([method, data]) => ({
		paymentMethod: method,
		amount: data.amount,
		currency: data.currency
	}));

	const cashIncome = incomesMap.get('point-of-sale')?.amount ?? 0;
	const totalOutcomes = params.outcomes.reduce((sum, outcome) => sum + outcome.amount, 0);
	const cashClosingTheoretical = {
		amount: session.cashOpening.amount + cashIncome - totalOutcomes,
		currency: session.cashOpening.currency
	};

	const cashDelta = {
		amount: params.cashClosing.amount - cashClosingTheoretical.amount,
		currency: session.cashOpening.currency
	};

	if (Math.abs(cashDelta.amount) > 0.01 && !params.cashDeltaJustification) {
		throw error(400, 'Cash delta justification is required when there is a difference');
	}

	const updatedSession: PosSession = {
		...session,
		status: 'closed',
		closedAt: new Date(),
		closedBy: params.user,
		cashClosing: params.cashClosing,
		cashClosingTheoretical,
		cashDelta,
		cashDeltaJustification: params.cashDeltaJustification,
		dailyIncomes,
		dailyOutcomes: params.outcomes,
		updatedAt: new Date()
	};

	await collections.posSessions.replaceOne({ _id: params.sessionId }, updatedSession);

	const zTicketText = generateZTicketText(updatedSession);

	return { session: updatedSession, zTicketText };
}

export async function generateXTicket(params: {
	sessionId: ObjectId;
	user: PosSessionUser;
}): Promise<string> {
	const session = await collections.posSessions.findOne({ _id: params.sessionId });

	if (!session) {
		throw error(404, 'POS session not found');
	}

	if (session.status !== 'active') {
		throw error(400, 'POS session is not active');
	}

	const incomesMap = await calculateDailyIncomes(session);

	await collections.posSessions.updateOne(
		{ _id: params.sessionId },
		{
			$push: {
				xTickets: {
					generatedAt: new Date(),
					generatedBy: params.user
				}
			},
			$set: {
				updatedAt: new Date()
			}
		}
	);

	return generateXTicketText(session, incomesMap);
}

export function generateZTicketText(session: PosSession): string {
	const currency = session.dailyIncomes[0]?.currency ?? session.cashOpening.currency;
	const totalIncome = session.dailyIncomes.reduce((sum, inc) => sum + inc.amount, 0);
	const totalOutcome = session.dailyOutcomes.reduce((sum, out) => sum + out.amount, 0);
	const cashIncome =
		session.dailyIncomes.find((i) => i.paymentMethod === 'point-of-sale')?.amount ?? 0;
	const cashOutcomes = totalOutcome;

	const incomeLines = session.dailyIncomes
		.map((inc) => `  - ${inc.paymentMethod} : ${inc.amount.toFixed(2)} ${inc.currency}`)
		.join('\n');

	const outcomeLines = session.dailyOutcomes
		.map((out) => `  - ${out.category} : ${out.amount.toFixed(2)} ${out.currency}`)
		.join('\n');

	return `${runtimeConfig.brandName} Z ticket
Opening time : ${session.openedAt.toLocaleString()} by ${
		session.openedBy.userAlias || session.openedBy.userLogin || session.openedBy.userId
	}
Closing time : ${session.closedAt?.toLocaleString()} by ${
		session.closedBy?.userAlias || session.closedBy?.userLogin || session.closedBy?.userId
	}${
		session.cashDelta && Math.abs(session.cashDelta.amount) > 0.01
			? '\nDaily Z includes cash balance error'
			: ''
	}

Daily incomes :
${incomeLines}
Daily incomes total :
  - ${totalIncome.toFixed(2)} ${currency}

Daily outcomes :
${outcomeLines}
Daily outcomes total :
  - ${totalOutcome.toFixed(2)} ${currency}

Daily delta : ${totalIncome - totalOutcome >= 0 ? '+' : ''}${(totalIncome - totalOutcome).toFixed(
		2
	)} ${currency}

Cash balance :
  - Initial cash at opening : ${session.cashOpening.amount.toFixed(2)} ${
		session.cashOpening.currency
	}
  - Daily cash incomes : ${cashIncome.toFixed(2)} ${currency}
  - Daily cash outcomes : ${cashOutcomes.toFixed(2)} ${currency}${
		session.cashClosing
			? `\n  - Remaining cash at daily closing : ${session.cashClosing.amount.toFixed(2)} ${
					session.cashClosing.currency
			  }`
			: ''
	}${
		session.cashClosingTheoretical
			? `\n  - Theorical remaining cash at daily closing : ${session.cashClosingTheoretical.amount.toFixed(
					2
			  )} ${session.cashClosingTheoretical.currency}`
			: ''
	}${
		session.cashDelta
			? `\nCash delta : ${
					session.cashDelta.amount >= 0 ? '+' : ''
			  }${session.cashDelta.amount.toFixed(2)} ${session.cashDelta.currency}`
			: ''
	}${session.cashDeltaJustification ? `\n  - Motive : ${session.cashDeltaJustification}` : ''}`;
}

function generateXTicketText(
	session: PosSession,
	incomesMap: Map<PaymentMethod, { amount: number; currency: Currency }>
): string {
	const currency = session.cashOpening.currency;
	const incomes = Array.from(incomesMap.entries());
	const totalIncome = incomes.reduce((sum, [, data]) => sum + data.amount, 0);

	const incomeLines = incomes
		.map(([method, data]) => `  - ${method} : ${data.amount.toFixed(2)} ${data.currency}`)
		.join('\n');

	return `${runtimeConfig.brandName} X ticket
Opening time : ${session.openedAt.toLocaleString()} by ${
		session.openedBy.userAlias || session.openedBy.userLogin || session.openedBy.userId
	}
X ticket current time : ${new Date().toLocaleString()} by ${
		session.openedBy.userAlias || session.openedBy.userLogin || session.openedBy.userId
	}

Daily incomes so far :
${incomeLines}
Daily incomes total so far :
  - ${totalIncome.toFixed(2)} ${currency}`;
}
