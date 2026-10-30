import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { MongoClient } from "mongodb";

export const CHECKPOINT_COLLECTION = "langgraphCheckpoints";
export const CHECKPOINT_WRITES_COLLECTION = "langgraphCheckpointWrites";

/**
 * Creates the durable LangGraph checkpointer in collections separate from
 * domain records, which remain the source of truth.
 */
export async function createMongoCheckpointerAsync(options: {
  client: MongoClient;
  dbName: string;
}): Promise<BaseCheckpointSaver> {
  const saver = new MongoDBSaver({
    // The saver is typed against its own mongodb driver copy.
    client: options.client as never,
    dbName: options.dbName,
    checkpointCollectionName: CHECKPOINT_COLLECTION,
    checkpointWritesCollectionName: CHECKPOINT_WRITES_COLLECTION,
  });
  await saver.setup();
  return saver as unknown as BaseCheckpointSaver;
}
