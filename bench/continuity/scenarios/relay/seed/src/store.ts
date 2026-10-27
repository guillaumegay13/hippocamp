export type DeliveryStatus = "pending" | "delivered" | "failed";

export type Delivery = {
  id: string;
  source: string;
  target: string;
  body: string;
  receivedAt: Date;
  status: DeliveryStatus;
  attempts: number;
};

export interface Store {
  save(delivery: Delivery): Promise<void>;
  get(id: string): Promise<Delivery | undefined>;
  list(): Promise<Delivery[]>;
}

export class MemoryStore implements Store {
  private deliveries = new Map<string, Delivery>();

  async save(delivery: Delivery): Promise<void> {
    this.deliveries.set(delivery.id, { ...delivery });
  }

  async get(id: string): Promise<Delivery | undefined> {
    const delivery = this.deliveries.get(id);
    return delivery && { ...delivery };
  }

  async list(): Promise<Delivery[]> {
    return [...this.deliveries.values()].map((delivery) => ({ ...delivery }));
  }
}
