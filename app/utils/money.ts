interface QuotationLike {
    units?: number;
    nano?: number;
}

export const quotationToNumber = (value: QuotationLike | undefined) => {
    if (!value) return undefined;
    return (value.units ?? 0) + (value.nano ?? 0) * 1e-9;
};

export const numberToQuotation = (value: number, currency = 'rub') => {
    const units = Math.trunc(value);
    const nano = Math.round((value - units) * 1e9);

    return {
        currency,
        units,
        nano
    };
};
