export interface FollowHistoryGuard {
	actorId: string
	followerId: string
	followUri: string
	statusId: string
}

export interface FederationDeliveryMetadata {
	followHistory?: FollowHistoryGuard
}
