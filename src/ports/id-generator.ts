export type IdGenerator = {
  randomUuid(): string;
};

export const cryptoIdGenerator: IdGenerator = {
  randomUuid() {
    return crypto.randomUUID();
  },
};
